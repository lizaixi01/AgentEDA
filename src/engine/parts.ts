/**
 * Part sourcing against the JLCPCB / LCSC catalogue (via the open jlcsearch index)
 * and import of exact EasyEDA parts (symbol pins + footprint + 3D model) as tscircuit components.
 */
import path from "node:path"
import fs from "node:fs/promises"
import { EdaError, ROOT, requireProject, touchProject } from "./project"

const JLCSEARCH = process.env.AEDA_JLCSEARCH_URL ?? "https://jlcsearch.tscircuit.com"

export interface PartHit {
  lcsc: string
  mpn: string
  package: string
  description: string
  /** null when the catalogue has no current stock figure */
  stock: number | null
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
  const fetchOnce = async (q: string) => {
    const url = new URL("/api/search", JLCSEARCH)
    url.searchParams.set("q", q)
    url.searchParams.set("limit", String(Math.max(limit * 3, 20)))
    if (opts.package) url.searchParams.set("package", opts.package)
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return ((await res.json()) as any).components ?? []
    } catch (e: any) {
      throw new EdaError(
        "parts_search_unavailable",
        `Part search failed: ${e?.message ?? e}`,
        "The catalogue is an online service. Retry, or continue without sourcing; the board still builds.",
      )
    }
  }
  // The catalogue matches the whole phrase, so a descriptive query often finds nothing.
  // Fall back to its most specific-looking words (those with digits, then the longest).
  let usedQuery = opts.query.trim()
  let rows: any[] = await fetchOnce(usedQuery)
  if (rows.length === 0) {
    const words = usedQuery.split(/\s+/).filter((w) => w.length >= 3)
    const ranked = [...words].sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)) || b.length - a.length)
    for (const w of ranked.slice(0, 3)) {
      if (w === usedQuery) continue
      rows = await fetchOnce(w)
      if (rows.length) {
        usedQuery = w
        break
      }
    }
  }
  let parts: PartHit[] = rows.map((c: any) => ({
    lcsc: `C${c.lcsc}`,
    mpn: c.mfr,
    package: c.package,
    description: String(c.description ?? "").slice(0, 160),
    stock: typeof c.stock === "number" ? c.stock : null,
    price: parsePrice(c.price),
    basic: Boolean(c.is_basic),
    preferred: Boolean(c.is_preferred),
  }))
  if (opts.package) {
    const want = opts.package.toLowerCase()
    const filtered = parts.filter((p) => p.package?.toLowerCase().includes(want))
    if (filtered.length) parts = filtered
  }
  // Unknown stock (null) is kept: exact part-number lookups often come back without a figure.
  if (opts.inStockOnly ?? true) parts = parts.filter((p) => p.stock === null || p.stock > 0)
  const beforeBasic = parts.length
  if (opts.basicOnly) parts = parts.filter((p) => p.basic)
  const basicFilteredAll = Boolean(opts.basicOnly) && beforeBasic > 0 && parts.length === 0
  // Prefer basic parts (no extended fee), then deep stock.
  parts.sort((a, b) => Number(b.basic) - Number(a.basic) || Number(b.preferred) - Number(a.preferred) || (b.stock ?? 0) - (a.stock ?? 0))
  parts = parts.slice(0, limit)
  return {
    query: opts.query,
    count: parts.length,
    parts,
    ...(basicFilteredAll
      ? { note: `${beforeBasic} part(s) match but none is a JLCPCB basic part. Search again without basic_only; an extended part adds a small one-off assembly fee.` }
      : parts.length === 0
      ? { note: "No in-stock match. The catalogue is indexed in English: search by manufacturer part number ('TP4056', 'MSK12C02') or English keywords ('slide switch', 'USB-C 16pin'), not Chinese. Or drop the package filter." }
      : usedQuery !== opts.query.trim()
        ? { note: `Nothing matched the full phrase; these match "${usedQuery}". Check each is the part you meant.` }
        : {}),
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
  // Library footprints of exposed-pad packages often carry thermal vias inside the pad.
  // The placement check treats a via on an SMD pad as a collision and refuses to route,
  // so they are dropped here and the caller is told.
  const thermalVias = (tsx.match(/^\s*<via\b[^>]*\/>\s*$/gm) ?? []).length
  if (thermalVias) tsx = tsx.replace(/^\s*<via\b[^>]*\/>\s*\n?/gm, "")
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
  const refdes = /<led\b/.test(tsx) ? "D1" : /<diode\b/.test(tsx) ? "D1" : /<connector\b|<pinheader\b|<jumper\b/.test(tsx) ? "J1" : /<resistor\b/.test(tsx) ? "R1" : /<capacitor\b/.test(tsx) ? "C1" : /<crystal\b/.test(tsx) ? "Y1" : /<pushbutton\b|<switch\b/.test(tsx) ? "SW1" : /<transistor\b|<mosfet\b/.test(tsx) ? "Q1" : "U1"
  // A generated <crystal> needs values the catalogue record does not carry.
  const needsCrystalProps = /<crystal\b/.test(tsx) && !/loadCapacitance=/.test(tsx)
  // No label block: fall back to the pad names so `pins` is never empty.
  if (Object.keys(pinLabels).length === 0)
    for (const m of tsx.matchAll(/portHints=\{\[\s*"([^"]+)"/g)) pinLabels[m[1]!] = m[1]!

  // Pad geometry, so the caller can tell signal pads from mounting tabs and work out orientation
  // without opening the generated file.
  const mm = (v: string | undefined) => Math.round(Number.parseFloat(v ?? "0") * 100) / 100
  const pads: { pin: string; x: number; y: number; w: number; h: number; type: "smd" | "hole" }[] = []
  for (const m of tsx.matchAll(/<(smtpad|platedhole)\b([^>]*)>/g)) {
    const a = m[2]!
    const hint = a.match(/portHints=\{\[([^\]]*)\]\}/)?.[1] ?? ""
    const pin = [...hint.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)[0] ?? "?"
    const attr = (k: string) => a.match(new RegExp(`\\b${k}="([^"]+)"`))?.[1]
    const w = mm(attr("width") ?? attr("outerDiameter") ?? attr("outerWidth") ?? attr("rectPadWidth"))
    const h = mm(attr("height") ?? attr("outerDiameter") ?? attr("outerHeight") ?? attr("rectPadHeight"))
    pads.push({ pin: pinLabels[pin] && pinLabels[pin] !== pin ? `${pin} (${pinLabels[pin]})` : pin, x: mm(attr("pcbX")), y: mm(attr("pcbY")), w, h, type: m[1] === "smtpad" ? "smd" : "hole" })
  }
  const xs = pads.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2])
  const ys = pads.flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2])
  const r2 = (n: number) => Math.round(n * 100) / 100
  const footprint = pads.length
    ? {
        padBoundsMm: { width: r2(Math.max(...xs) - Math.min(...xs)), height: r2(Math.max(...ys) - Math.min(...ys)) },
        padBoundsCentreMm: { x: r2((Math.max(...xs) + Math.min(...xs)) / 2), y: r2((Math.max(...ys) + Math.min(...ys)) / 2) },
        pads: pads.length > 40 ? pads.slice(0, 40) : pads,
        ...(pads.length > 40 ? { padsOmitted: pads.length - 40 } : {}),
      }
    : undefined

  return {
    lcsc: partNumber,
    mpn: String(mpn),
    file: rel,
    component: exportName,
    import: `import { ${exportName} } from "./${rel.replace(/\.tsx$/, "")}"`,
    usage: needsCrystalProps
      ? `<${exportName} name="${refdes}" frequency="12MHz" loadCapacitance="20pF" />`
      : `<${exportName} name="${refdes}" />`,
    ...(needsCrystalProps
      ? { requiredProps: "This is a crystal: pass frequency and loadCapacitance (from its datasheet) where you use it, or it will not compile. On 4-pad crystals two pads are the crystal and the other two are ground; the pad table shows which are diagonal." }
      : {}),
    pins: pinLabels,
    footprint,
    footprintNote:
      "Pad positions are in mm relative to the part origin (the point pcbX/pcbY places), unrotated, +y up. Large pads away from the signal row are usually mounting tabs or shell pins: tie them to GND. The body, a connector opening or a switch lever is on the side the silkscreen extends to; confirm with render after placing. If the part must overhang the board edge, add allowOffBoard.",
    ...(thermalVias
      ? {
          removedThermalVias: thermalVias,
          thermalNote: `Removed ${thermalVias} thermal via(s) from the exposed pad (via-in-pad blocks routing here). Connect the pad to a ground pour for heat spreading.`,
        }
      : {}),
    note: `Wire pins by label, e.g. <trace from="${refdes}.${Object.values(pinLabels)[0] ?? "pin1"}" to="net.GND" />. Layout props (pcbX, pcbY, pcbRotation) work on it like on any part.`,
  }
}


// ---- BOM enrichment --------------------------------------------------------

export interface PartInfo {
  lcsc: string
  mpn: string
  package: string
  description: string
  price: number | null
  stock: number | null
  basic: boolean
  fetchedAt: number
}

const CACHE_FILE = path.join(ROOT, ".cache", "parts.json")
const CACHE_TTL = 24 * 3600 * 1000
let cache: Record<string, PartInfo> | null = null

async function loadCache() {
  if (cache) return cache
  try {
    cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"))
  } catch {
    cache = {}
  }
  return cache!
}

/** Price / stock / basic-ness for a set of LCSC numbers. Network failures just leave parts out. */
export async function lookupParts(numbers: string[]): Promise<Record<string, PartInfo>> {
  const store = await loadCache()
  const now = Date.now()
  const wanted = [...new Set(numbers)].filter((n) => /^C\d+$/.test(n))
  const missing = wanted.filter((n) => !store[n] || now - store[n]!.fetchedAt > CACHE_TTL)
  let dirty = false
  const queue = [...missing]
  await Promise.all(
    Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (let n = queue.shift(); n; n = queue.shift()) {
        try {
          const url = new URL("/api/search", JLCSEARCH)
          url.searchParams.set("q", n)
          url.searchParams.set("limit", "5")
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
          if (!res.ok) continue
          const data: any = await res.json()
          const hit = (data.components ?? []).find((c: any) => `C${c.lcsc}` === n)
          if (!hit) continue
          store[n] = {
            lcsc: n,
            mpn: hit.mfr,
            package: hit.package,
            description: String(hit.description ?? "").slice(0, 160),
            price: parsePrice(hit.price),
            stock: typeof hit.stock === "number" ? hit.stock : null,
            basic: Boolean(hit.is_basic),
            fetchedAt: now,
          }
          dirty = true
        } catch {}
      }
    }),
  )
  if (dirty) {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true })
    await fs.writeFile(CACHE_FILE, JSON.stringify(store)).catch(() => {})
  }
  return Object.fromEntries(wanted.filter((n) => store[n]).map((n) => [n, store[n]!]))
}


// ---- parametric browsing by category -----------------------------------------

export const PART_CATEGORIES = [
  "resistors", "capacitors", "leds", "diodes", "bjt_transistors", "mosfets", "fuses", "potentiometers", "resistor_arrays",
  "ldos", "voltage_regulators", "boost_converters", "buck_boost_converters", "led_drivers", "stepper_motor_drivers",
  "microcontrollers", "arm_processors", "risc_v_processors", "wifi_modules", "ble_modules", "ble_chips", "io_expanders",
  "adcs", "dacs", "analog_multiplexers", "analog_switches", "accelerometers", "gyroscopes", "gas_sensors", "optical_sensors", "microphones",
  "switches", "relays", "buzzers", "headers", "jst_connectors", "usb_c_connectors", "micro_usb_connectors", "wire_to_board_connectors",
  "fpc_connectors", "barrel_jacks", "battery_holders", "spring_clamp_terminal_blocks", "oled_display", "led_with_ic",
] as const

/**
 * List parts of one category with their electrical attributes (voltage rating, colour, pitch ...),
 * filtered server-side by exact attribute values and client-side by text.
 */
export async function browseParts(opts: {
  category: string
  package?: string
  where?: string
  contains?: string
  basicOnly?: boolean
  limit?: number
}) {
  if (!(PART_CATEGORIES as readonly string[]).includes(opts.category))
    throw new EdaError("unknown_category", `No category "${opts.category}"`, `Use one of: ${PART_CATEGORIES.join(", ")}`)
  const limit = Math.min(opts.limit ?? 10, 40)
  const url = new URL(`/${opts.category}/list.json`, JLCSEARCH)
  if (opts.package) url.searchParams.set("package", opts.package)
  // The catalogue wants SI base units for values ("10uF" -> 0.00001).
  const SI: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }
  const toSi = (v: string) => {
    const m = v.match(/^([\d.]+)\s*([pnuµmkKMG]?)\s*(?:F|H|Hz|ohm|Ω|R)?$/)
    return m ? String(Number((Number(m[1]) * (SI[m[2]!] ?? 1)).toPrecision(6))) : v
  }
  for (const pair of (opts.where ?? "").split(",")) {
    const [k, ...rest] = pair.split("=")
    if (!k?.trim() || !rest.length) continue
    const key = k.trim()
    const value = rest.join("=").trim()
    url.searchParams.set(key, /^(capacitance|resistance|inductance|frequency)$/.test(key) ? toSi(value) : value)
  }
  if (opts.basicOnly) url.searchParams.set("is_basic", "true")
  let rows: any[]
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data: any = await res.json()
    rows = (Object.values(data)[0] as any[]) ?? []
  } catch (e: any) {
    throw new EdaError("parts_search_unavailable", `Catalogue request failed: ${e?.message ?? e}`, "The catalogue is an online service. Retry.")
  }
  const fetched = rows.length
  const words = (opts.contains ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const text = (r: any) => `${r.mfr} ${r.description} ${r.package}`.toLowerCase()
  // Stock is often unknown (null) in category listings; only a known zero excludes a part.
  let out = rows.filter((r) => r.stock !== 0 && words.every((w) => text(r).includes(w)))
  const beforeBasic = out.length
  if (opts.basicOnly) out = out.filter((r) => r.is_basic)
  out.sort((a, b) => Number(b.is_basic) - Number(a.is_basic) || (b.stock ?? 0) - (a.stock ?? 0))
  const parts = out.slice(0, limit).map((r) => {
    const { lcsc, mfr, description, stock, price1, in_stock: _i, is_basic, is_preferred: _p, attributes: _a, package: pkg, ...attrs } = r
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== "" && typeof v !== "object") clean[k] = v
    return { lcsc: `C${lcsc}`, mpn: mfr, package: pkg, stock: stock ?? null, price: typeof price1 === "number" ? price1 : null, basic: Boolean(is_basic), ...clean, description: String(description ?? "").slice(0, 120) }
  })
  const attributeNames = rows[0] ? Object.keys(rows[0]).filter((k) => !["lcsc", "mfr", "description", "stock", "price1", "in_stock", "is_basic", "is_preferred", "attributes"].includes(k)) : []
  return {
    category: opts.category,
    count: parts.length,
    parts,
    filterableAttributes: attributeNames,
    ...(parts.length === 0
      ? {
          note: opts.basicOnly && beforeBasic > 0
            ? `${beforeBasic} part(s) match but none is a basic part. Retry without basic_only.`
            : fetched === 0
              ? "The catalogue returned nothing for these filters. Loosen `where` / `package` (values must match exactly, e.g. package=0805, color=green)."
              : `None of the ${fetched} parts fetched match "${opts.contains}". The catalogue returns at most 100 rows per request: narrow with package / where first, then use contains.`,
        }
      : {}),
  }
}
