/**
 * Manufacturing + interchange exports. Output layout matches what JLCPCB's order page accepts:
 *   <project>/.aeda/fab/gerbers.zip   (Protel-style extensions)
 *   <project>/.aeda/fab/bom.csv       (Comment, Designator, Footprint, JLCPCB Part #)
 *   <project>/.aeda/fab/cpl.csv       (Designator, Mid X, Mid Y, Layer, Rotation)
 */
import path from "node:path"
import fs from "node:fs/promises"
import JSZip from "jszip"
import {
  convertCircuitJsonToGerberCommands,
  stringifyGerberCommandLayers,
  convertCircuitJsonToExcellonDrillCommands,
  stringifyExcellonDrill,
} from "circuit-json-to-gerber"
import { convertCircuitJsonToPickAndPlaceCsv, convertCircuitJsonToPickAndPlaceRows } from "circuit-json-to-pnp-csv"
import { CircuitJsonToKicadPcbConverter, CircuitJsonToKicadSchConverter } from "circuit-json-to-kicad"
import { buildDir, EdaError } from "./project"
import { readCircuitJson, readReport } from "./build"

const GERBER_EXT: Record<string, string> = {
  F_Cu: "GTL",
  B_Cu: "GBL",
  F_Mask: "GTS",
  B_Mask: "GBS",
  F_SilkScreen: "GTO",
  B_SilkScreen: "GBO",
  F_Paste: "GTP",
  B_Paste: "GBP",
  Edge_Cuts: "GKO",
  In1_Cu: "G1",
  In2_Cu: "G2",
}

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`

export interface ExportResult {
  project: string
  dir: string
  files: { name: string; bytes: number; description: string }[]
  blockers: string[]
  verification: GerberVerification
  order: { board: string; steps: string[] }
}

export interface GerberVerification {
  ok: boolean
  parser: string
  layers: { file: string; type: string | null; side: string | null }[]
  missing: string[]
  /** Board size as read back from the outline layer, mm */
  sizeMm: { width: number; height: number } | null
  sizeMatchesDesign: boolean | null
  previews: string[]
  note?: string
}

const REQUIRED_LAYERS: [string, string][] = [
  ["copper", "top"],
  ["copper", "bottom"],
  ["soldermask", "top"],
  ["soldermask", "bottom"],
  ["outline", "all"],
]

async function verifyGerbers(id: string, zip: JSZip, board: { widthMm: number; heightMm: number } | null): Promise<GerberVerification> {
  const previewDir = path.join(buildDir(id), "fab-preview")
  await fs.rm(previewDir, { recursive: true, force: true })
  try {
    const { default: pcbStackup } = (await import("pcb-stackup")) as any
    const inputs: { filename: string; gerber: string }[] = []
    for (const [filename, file] of Object.entries(zip.files)) inputs.push({ filename, gerber: await file.async("string") })
    const stackup = await pcbStackup(inputs)
    const layers = stackup.layers.map((l: any) => ({ file: l.filename, type: l.type ?? null, side: l.side ?? null }))
    const missing = REQUIRED_LAYERS.filter(([type, side]) => !layers.some((l: any) => l.type === type && l.side === side)).map(
      ([type, side]) => `${type}/${side}`,
    )
    const toMm = (v: number) => (stackup.top.units === "in" ? v * 25.4 : v)
    const sizeMm =
      typeof stackup.top.width === "number" ? { width: Math.round(toMm(stackup.top.width) * 100) / 100, height: Math.round(toMm(stackup.top.height) * 100) / 100 } : null
    const sizeMatchesDesign =
      sizeMm && board ? Math.abs(sizeMm.width - board.widthMm) < 0.5 && Math.abs(sizeMm.height - board.heightMm) < 0.5 : null
    await fs.mkdir(previewDir, { recursive: true })
    await fs.writeFile(path.join(previewDir, "top.svg"), stackup.top.svg)
    await fs.writeFile(path.join(previewDir, "bottom.svg"), stackup.bottom.svg)
    return {
      ok: missing.length === 0 && sizeMatchesDesign !== false,
      parser: "tracespace pcb-stackup",
      layers,
      missing,
      sizeMm,
      sizeMatchesDesign,
      previews: [".aeda/fab-preview/top.svg", ".aeda/fab-preview/bottom.svg"],
    }
  } catch (e: any) {
    return {
      ok: false,
      parser: "tracespace pcb-stackup",
      layers: [],
      missing: [],
      sizeMm: null,
      sizeMatchesDesign: null,
      previews: [],
      note: `Gerber read-back failed: ${e?.message ?? e}`,
    }
  }
}

export async function exportFab(id: string, opts: { force?: boolean } = {}): Promise<ExportResult> {
  const report = await readReport(id)
  const circuitJson = await readCircuitJson(id)
  if (!report) throw new EdaError("not_built", `Project "${id}" has not been built`, "Call build first.")
  const blockers = report.errors.map((e) => `${e.code}: ${e.message}`)
  if (blockers.length && !opts.force)
    throw new EdaError(
      "design_has_errors",
      `Refusing to export: the last build has ${blockers.length} error(s). First: ${blockers[0]}`,
      "Fix the errors and rebuild. Pass force only if you deliberately want files for a broken board.",
    )

  const fabDir = path.join(buildDir(id), "fab")
  await fs.rm(fabDir, { recursive: true, force: true })
  await fs.mkdir(fabDir, { recursive: true })
  const files: ExportResult["files"] = []
  const put = async (name: string, data: string | Uint8Array, description: string) => {
    await fs.writeFile(path.join(fabDir, name), data)
    files.push({ name, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.byteLength, description })
  }

  // Gerbers + drills
  const zip = new JSZip()
  const layers = stringifyGerberCommandLayers(convertCircuitJsonToGerberCommands(circuitJson as any)) as Record<string, string>
  for (const [layer, content] of Object.entries(layers)) {
    const inner = /^In(\d+)_Cu$/.exec(layer)
    const ext = GERBER_EXT[layer] ?? (inner ? `G${inner[1]}` : undefined)
    if (!ext) continue // fab notes etc. are not sent to the fab
    zip.file(`${id}.${ext}`, content)
  }
  for (const plated of [true, false]) {
    try {
      const drill = stringifyExcellonDrill(
        convertCircuitJsonToExcellonDrillCommands({ circuitJson: circuitJson as any, is_plated: plated }),
      )
      // Only include a drill file if it actually drills something
      if (/^T\d+C/m.test(drill) && /^X-?\d/m.test(drill)) zip.file(`${id}-${plated ? "PTH" : "NPTH"}.DRL`, drill)
    } catch {}
  }
  await put("gerbers.zip", await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }), "Gerber + drill files. Upload to JLCPCB as the PCB file.")

  // Read the Gerbers back with an independent parser. This is the check that what we are about
  // to hand the fab is well-formed, has every layer, and is the size the design says it is.
  const verification = await verifyGerbers(id, zip, report.summary.board)
  // Every copper layer of the board must be in the archive, inner layers included.
  const copperWritten = Object.keys(zip.files).filter((f) => /\.(GTL|GBL|G\d+)$/.test(f)).length
  const copperWanted = report.summary.board?.layers ?? 2
  if (copperWritten < copperWanted) {
    verification.ok = false
    verification.missing.push(`copper layers (board has ${copperWanted}, archive has ${copperWritten})`)
  }

  // BOM (grouped, JLCPCB column names)
  const bomRows = [["Comment", "Designator", "Footprint", "JLCPCB Part #"].map(csvCell).join(",")]
  // The BOM and the placement list must name the same parts, or the assembly order is rejected:
  // a part the placement list leaves out (do-not-place) is left out here too.
  const placed = new Set((convertCircuitJsonToPickAndPlaceRows(circuitJson as any) as any[]).map((r) => String(r.designator)))
  for (const line of report.bom) {
    const designators = line.designators.filter((d) => placed.has(d))
    if (!designators.length) continue
    bomRows.push([line.value || line.mpn || line.kind, designators.join(","), line.footprint, line.lcsc ?? ""].map(csvCell).join(","))
  }
  await put("bom.csv", bomRows.join("\n") + "\n", "Bill of materials for JLCPCB assembly.")

  // CPL / pick and place
  await put("cpl.csv", convertCircuitJsonToPickAndPlaceCsv(circuitJson as any) + "\n", "Component placement list for JLCPCB assembly.")

  // KiCad interchange, so the board can be opened and finished in a desktop tool
  try {
    const pcb = new CircuitJsonToKicadPcbConverter(circuitJson as any)
    pcb.runUntilFinished()
    await put(`${id}.kicad_pcb`, pcb.getOutputString(), "KiCad PCB (open in KiCad 8+).")
    const sch = new CircuitJsonToKicadSchConverter(circuitJson as any)
    sch.runUntilFinished()
    await put(`${id}.kicad_sch`, sch.getOutputString(), "KiCad schematic.")
  } catch (e: any) {
    // interchange is best-effort; fab files above are what matters
  }

  // Mechanical hand-off: the assembled board as a STEP solid for enclosure design in a CAD tool.
  try {
    const { circuitJsonToStep } = (await import("circuit-json-to-step")) as any
    const step: string = await circuitJsonToStep(circuitJson, { includeComponents: true })
    if (typeof step === "string" && step.startsWith("ISO-10303-21")) await put(`${id}.step`, step, "3D STEP model of the assembled board, for mechanical CAD (enclosure design).")
  } catch {
    // best-effort: fab files do not depend on it
  }

  await put("circuit.json", JSON.stringify(circuitJson), "Circuit JSON (tscircuit interchange).")

  // One bundle with everything
  const bundle = new JSZip()
  for (const f of files) bundle.file(f.name, await fs.readFile(path.join(fabDir, f.name)))
  const b = report.summary.board
  const unsourced = report.bom.filter((l) => !l.sourced).flatMap((l) => l.designators)
  const readme = [
    `# ${id} - manufacturing files`,
    ``,
    `Board: ${b ? `${b.widthMm} x ${b.heightMm} mm, ${b.layers} layers, ${b.thicknessMm} mm` : "unknown"}`,
    `Components: ${report.summary.components}   BOM lines: ${report.summary.bomLines} (${report.summary.bomSourced} with LCSC part numbers)`,
    `Design checks at export: ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
    unsourced.length ? `Not sourced (hand-solder or pick a part): ${unsourced.join(", ")}` : `All BOM lines have LCSC part numbers.`,
    ``,
    `## Order at JLCPCB`,
    `1. https://cart.jlcpcb.com/quote -> "Add gerber file" -> gerbers.zip`,
    `2. Enable "PCB Assembly", upload bom.csv and cpl.csv`,
    `3. Check part matching and placement preview, then order.`,
    ``,
  ].join("\n")
  bundle.file("README.md", readme)
  await put(`${id}-fab.zip`, await bundle.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }), "Everything above in one archive.")

  await fs.writeFile(path.join(buildDir(id), "fab-verification.json"), JSON.stringify(verification, null, 2))
  return {
    project: id,
    dir: path.relative(process.cwd(), fabDir) || fabDir,
    files,
    blockers,
    verification,
    order: {
      board: b ? `${b.widthMm} x ${b.heightMm} mm, ${b.layers} layers` : "unknown",
      steps: [
        "Upload gerbers.zip at https://cart.jlcpcb.com/quote",
        "For assembly: enable PCB Assembly and upload bom.csv + cpl.csv",
        unsourced.length
          ? `These parts have no LCSC number and will not be assembled: ${unsourced.join(", ")}`
          : "All parts are sourced from LCSC.",
      ],
    },
  }
}

export async function export3d(id: string): Promise<{ file: string; bytes: number }> {
  const circuitJson = await readCircuitJson(id)
  const { convertCircuitJsonToGltf } = await import("circuit-json-to-gltf")
  const glb: any = await convertCircuitJsonToGltf(circuitJson as any, { format: "glb" } as any)
  const out = path.join(buildDir(id), "board.glb")
  const data = glb instanceof ArrayBuffer ? new Uint8Array(glb) : glb
  await fs.writeFile(out, data)
  return { file: ".aeda/board.glb", bytes: data.byteLength }
}
