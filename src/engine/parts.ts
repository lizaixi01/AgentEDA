/**
 * Part sourcing against the JLCPCB / LCSC catalogue (via the open jlcsearch index)
 * and import of exact EasyEDA parts (symbol pins + footprint + 3D model) as tscircuit components.
 */
import path from "node:path"
import fs from "node:fs/promises"
import { EdaError, requireProject, touchProject } from "./project"

const JLCSEARCH = process.env.AEDA_JLCSEARCH_URL ?? "https://jlcsearch.tscircuit.com"

export interface PartHit {
  lcsc: string
  mpn: string
  package: string
  description: string
  stock: number
  /** USD at qty 1 */
  price: number | null
  /** JLCPCB "basic" parts carry no extended-part assembly fee */
  basic: boolean
  preferred: boolean
}

function parsePrice(p: unknown): number | null {
  if (typeof p === "number") return p
  if (typeof p === "string") {
    // "1-9:2.1833,10-29:1.9067" or JSON
    const m = p.match(/:\s*([0-9.]+)/) ?? p.match(/([0-9.]+)/)
    return m ? Number(m[1]) : null
  }
  return null
}

export async function searchParts(opts: {
  query: string
  package?: string
  limit?: number
  inStockOnly?: boolean
  basicOnly?: boolean
}): Promise<{ query: string; count: number; parts: PartHit[]; note?: string }> {
  const limit = Math.min(opts.limit ?? 10, 50)
  const url = new URL("/api/search", JLCSEARCH)
  url.searchParams.set("q", opts.query)
  url.searchParams.set("limit", String(Math.max(limit * 3, 20)))
  if (opts.package) url.searchParams.set("package", opts.package)
  let data: any
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data = await res.json()
  } catch (e: any) {
    throw new EdaError(
      "parts_search_unavailable",
      `Part search failed: ${e?.message ?? e}`,
      "The catalogue is an online service. Retry, or continue without sourcing; the board still builds.",
    )
  }
  let parts: PartHit[] = (data.components ?? []).map((c: any) => ({
    lcsc: `C${c.lcsc}`,
    mpn: c.mfr,
    package: c.package,
    description: String(c.description ?? "").slice(0, 160),
    stock: c.stock ?? 0,
    price: parsePrice(c.price),
    basic: Boolean(c.is_basic),
    preferred: Boolean(c.is_preferred),
  }))
  if (opts.package) {
    const want = opts.package.toLowerCase()
    const filtered = parts.filter((p) => p.package?.toLowerCase().includes(want))
    if (filtered.length) parts = filtered
  }
  if (opts.inStockOnly ?? true) parts = parts.filter((p) => p.stock > 0)
  if (opts.basicOnly) parts = parts.filter((p) => p.basic)
  // Prefer basic parts (no extended fee), then deep stock.
  parts.sort((a, b) => Number(b.basic) - Number(a.basic) || Number(b.preferred) - Number(a.preferred) || b.stock - a.stock)
  parts = parts.slice(0, limit)
  return {
    query: opts.query,
    count: parts.length,
    parts,
    ...(parts.length === 0 ? { note: "No in-stock match. Try a shorter query (the bare part number) or drop the package filter." } : {}),
  }
}

/**
 * Fetch an exact LCSC part and write it into the project as lib/<Name>.tsx.
 * The generated component carries the real footprint, pin labels, 3D model and LCSC number.
 */
export async function importPart(id: string, lcsc: string) {
  const dir = requireProject(id)
  const partNumber = lcsc.toUpperCase().startsWith("C") ? lcsc.toUpperCase() : `C${lcsc}`
  if (!/^C\d+$/.test(partNumber)) throw new EdaError("bad_part_number", `"${lcsc}" is not an LCSC part number (expected like C6186)`)
  const { fetchEasyEDAComponent, convertRawEasyEdaToTs, normalizeManufacturerPartNumber } = await import("easyeda")
  let raw: any
  try {
    raw = await fetchEasyEDAComponent(partNumber)
  } catch (e: any) {
    throw new EdaError(
      "part_fetch_failed",
      `Could not fetch ${partNumber} from EasyEDA: ${e?.message ?? e}`,
      "Check the number with search_parts. Some catalogue parts have no EasyEDA footprint.",
    )
  }
  let tsx: string
  try {
    tsx = await (convertRawEasyEdaToTs as any)({ rawEasy: raw })
  } catch (e: any) {
    throw new EdaError("part_convert_failed", `Could not convert ${partNumber}: ${e?.message ?? e}`)
  }
  const mpn = raw?.dataStr?.head?.c_para?.["Manufacturer Part"] ?? partNumber
  const exportName = tsx.match(/export const (\w+)/)?.[1] ?? normalizeManufacturerPartNumber(String(mpn))
  const rel = `lib/${exportName}.tsx`
  await fs.mkdir(path.join(dir, "lib"), { recursive: true })
  await fs.writeFile(path.join(dir, rel), tsx)
  await touchProject(id)

  // Pull pin labels out of the generated code so the agent can wire it without reading the file.
  const pinLabels: Record<string, string> = {}
  const block = tsx.match(/pinLabels\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] ?? ""
  for (const m of block.matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    const labels = [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)
    pinLabels[m[1]!] = labels[0] ?? m[1]!
  }
  return {
    lcsc: partNumber,
    mpn: String(mpn),
    file: rel,
    component: exportName,
    import: `import { ${exportName} } from "./${rel.replace(/\.tsx$/, "")}"`,
    usage: `<${exportName} name="U1" />`,
    pins: pinLabels,
    note: `Wire pins by label, e.g. <trace from=".U1 > .${Object.values(pinLabels)[0] ?? "pin1"}" to="net.GND" />`,
  }
}
