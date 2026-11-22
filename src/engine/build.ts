/**
 * build = compile (isolated subprocess) -> analyze (ERC/DRC/BOM) -> render previews.
 * Everything lands in <project>/.aeda/ so the web UI, CLI and MCP all read the same artifacts.
 */
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import {
  convertCircuitJsonToPcbSvg,
  convertCircuitJsonToSchematicSvg,
  convertCircuitJsonToAssemblySvg,
  convertCircuitJsonToSimulationGraphSvg,
} from "circuit-to-svg"
import { analyzeCircuitJson, type DesignReport, type Diagnostic } from "./analyze"
import { lookupParts } from "./parts"
import { ENTRY, buildDir, requireProject, snapshot, touchProject, EdaError } from "./project"

export type BuildStage = "compile" | "analyze" | "render" | "done"
export interface BuildProgress {
  stage: BuildStage
  /** 0..1 */
  progress: number
  message: string
}

export interface BuildResult extends DesignReport {
  project: string
  version?: number
  durationMs: number
  artifacts: Record<string, string>
  /** Present only when compilation itself failed */
  compileError?: { phase: string; message: string; file?: string; line?: number; column?: number; stack?: string }
}

const RUNNER = path.join(import.meta.dir, "runner.tsx")

function emptyReport(): DesignReport {
  return {
    ok: false,
    status: "compile_failed",
    summary: {
      board: null,
      components: 0,
      nets: 0,
      pins: 0,
      traces: 0,
      vias: 0,
      traceLengthMm: 0,
      connectionsRouted: 0,
      connectionsTotal: 0,
      bomLines: 0,
      bomSourced: 0,
      errors: 1,
      warnings: 0,
    },
    errors: [],
    warnings: [],
    info: [],
    components: [],
    nets: [],
    bom: [],
  }
}

const building = new Map<string, Promise<BuildResult>>()

export interface BuildOptions {
  /** Skip the online JLCPCB part lookup (faster, works offline; BOM will be unsourced) */
  noParts?: boolean
  timeoutMs?: number
  message?: string
  onProgress?: (p: BuildProgress) => void
}

/** Serialises builds per project: a second caller waits for, then reuses, nothing - it queues its own run. */
export async function buildProject(id: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const prev = building.get(id)
  const run = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() => doBuild(id, opts))
  building.set(id, run)
  try {
    return await run
  } finally {
    if (building.get(id) === run) building.delete(id)
  }
}

/**
 * One build per project across processes (web server, CLI, MCP all write the same .aeda folder).
 * The lock holds the owner's pid; a lock whose process is gone, or older than ten minutes, is stale.
 */
async function withBuildLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const out = buildDir(id)
  await fs.mkdir(out, { recursive: true })
  const lock = path.join(out, "build.lock")
  const deadline = Date.now() + 240_000
  for (;;) {
    try {
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" })
      break
    } catch {
      let stale = true
      try {
        const owner = JSON.parse(await fs.readFile(lock, "utf8"))
        if (Date.now() - owner.at < 600_000) {
          try {
            process.kill(owner.pid, 0) // throws when the process no longer exists
            stale = owner.pid === process.pid
          } catch {
            stale = true
          }
        }
      } catch {}
      if (stale) {
        await fs.rm(lock, { force: true })
        continue
      }
      if (Date.now() > deadline)
        throw new EdaError("build_busy", `Another process has been building "${id}" for several minutes`, "Wait for it to finish, then build again.")
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lock, { force: true })
  }
}

function doBuild(id: string, opts: BuildOptions): Promise<BuildResult> {
  requireProject(id)
  return withBuildLock(id, () => doBuildLocked(id, opts))
}

async function doBuildLocked(id: string, opts: BuildOptions): Promise<BuildResult> {
  const dir = requireProject(id)
  const out = buildDir(id)
  await fs.mkdir(out, { recursive: true })
  const started = Date.now()
  // Progress is also mirrored to disk so other processes (the web server) can show builds
  // started from the CLI or an MCP client.
  const progressFile = path.join(out, "progress.json")
  const progress = (stage: BuildStage, p: number, message: string) => {
    opts.onProgress?.({ stage, progress: p, message })
    fs.writeFile(progressFile, JSON.stringify({ stage, progress: p, message, at: Date.now() })).catch(() => {})
  }

  const entry = path.join(dir, ENTRY)
  if (!existsSync(entry))
    throw new EdaError("no_entry", `Project "${id}" has no ${ENTRY}`, `Write the design to ${ENTRY} first.`)

  // ---- compile ---------------------------------------------------------
  progress("compile", 0.05, "Compiling circuit, placing parts and routing traces")
  const envelopeFile = path.join(out, "run.json")
  await fs.rm(envelopeFile, { force: true })
  // Use the same runtime binary this process runs on: `bun` is often not on PATH for agents and GUI apps.
  const args = [process.execPath, "run", RUNNER, entry, envelopeFile]
  if (opts.noParts) args.push("--no-parts")
  const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "0" } })
  const timeoutMs = opts.timeoutMs ?? 180_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  // Fake-but-honest progress: creep toward 0.7 while the subprocess works.
  let creep = 0.05
  const ticker = setInterval(() => {
    creep = Math.min(0.7, creep + (0.7 - creep) * 0.12)
    progress("compile", creep, "Compiling circuit, placing parts and routing traces")
  }, 500)
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text(), proc.exited])
  clearTimeout(timer)
  clearInterval(ticker)

  let envelope: any = null
  if (existsSync(envelopeFile)) {
    try {
      envelope = JSON.parse(await fs.readFile(envelopeFile, "utf8"))
    } catch {}
  }
  if (!envelope) {
    envelope = {
      ok: false,
      error: timedOut
        ? {
            phase: "timeout",
            message: `Build exceeded ${Math.round(timeoutMs / 1000)}s. The autorouter is probably stuck: enlarge the board, reduce density, or split the design.`,
          }
        : { phase: "crash", message: (stderr || "Compiler subprocess crashed with no output").slice(-2000) },
    }
  }

  const artifacts: Record<string, string> = {}
  let report: DesignReport

  if (!envelope.ok) {
    const err = envelope.error
    // A failed compile invalidates everything derived from the previous build; nothing stale may be exported or shown.
    for (const stale of ["circuit.json", "fab", "fab-preview", "fab-verification.json", "board.glb", "report.html", "pcb.svg", "schematic.svg", "assembly.svg", "simulation.svg"])
      await fs.rm(path.join(out, stale), { recursive: true, force: true })
    report = emptyReport()
    const rel = err.file ? path.relative(dir, err.file) : undefined
    const d: Diagnostic = {
      severity: "error",
      code: `compile_${err.phase}`,
      message: `${rel ? `${rel}${err.line ? `:${err.line}` : ""}: ` : ""}${err.message}`,
      hint:
        err.phase === "import"
          ? "The TSX did not load: syntax error, bad import path, or missing export. Fix the file and build again."
          : "The circuit threw while rendering. Check prop names/units (e.g. resistance=\"10k\", footprint=\"0402\") and trace selectors.",
    }
    report.errors.push(d)
    const result: BuildResult = {
      ...report,
      project: id,
      durationMs: Date.now() - started,
      artifacts,
      compileError: { ...err, file: rel },
    }
    await fs.writeFile(path.join(out, "report.json"), JSON.stringify(result, null, 2))
    const v = await snapshot(id, opts.message ?? "build (compile failed)", "compile_failed")
    result.version = v.version
    await fs.writeFile(path.join(out, "report.json"), JSON.stringify(result, null, 2))
    await touchProject(id)
    progress("done", 1, "Compile failed")
    return result
  }

  const circuitJson: any[] = envelope.circuitJson
  // Exports belong to the build they were made from; never leave stale fab files next to a newer design.
  await fs.rm(path.join(out, "fab"), { recursive: true, force: true })
  await fs.rm(path.join(out, "fab-preview"), { recursive: true, force: true })
  await fs.rm(path.join(out, "fab-verification.json"), { force: true })
  await fs.rm(path.join(out, "report.html"), { force: true })
  await fs.rm(path.join(out, "board.glb"), { force: true })
  await fs.writeFile(path.join(out, "circuit.json"), JSON.stringify(circuitJson))
  artifacts.circuitJson = ".aeda/circuit.json"
  await fs.rm(envelopeFile, { force: true })

  // ---- analyze ---------------------------------------------------------
  progress("analyze", 0.75, "Running electrical and design rule checks")
  report = await analyzeCircuitJson(circuitJson)

  // A pour that reaches nothing on its layer is silently dropped by the compiler; say so.
  try {
    const source = await fs.readFile(entry, "utf8")
    const requested = (source.match(/<copperpour\b/g) ?? []).length
    const produced = circuitJson.filter((e) => e.type === "pcb_copper_pour").length
    if (requested > produced) {
      report.warnings.push({
        severity: "warning",
        code: "copper_pour_empty",
        message: `${requested - produced} of ${requested} <copperpour> element(s) produced no copper: nothing on that net exists on the pour's layer.`,
        hint: 'Put the pour on the layer where the net\'s pads are (layer="top" for an all-SMD board). A bottom pour only works when through-hole pins or vias of that net reach the bottom layer.',
      })
      report.summary.warnings = report.warnings.length
      if (report.status === "pass") report.status = "warnings"
    }
  } catch {}

  // A testbench that produced no waveforms must not look like a pass.
  try {
    const source = await fs.readFile(entry, "utf8")
    if (/<(analogsimulation|analog\.transientsimulation)\b/.test(source) && !report.simulation) {
      report.errors.push({
        severity: "error",
        code: "simulation_no_result",
        message: "The design has an <analogsimulation> but the simulator returned no waveforms.",
        hint: "Usual causes: no <voltageprobe>, a source that failed to be created (see other errors), two voltage sources in series or in parallel, or a node with no DC path to ground. Use one source per rail, connect every source's pin2 to net.GND, and rebuild.",
      })
      report.ok = false
      report.status = "errors"
      report.summary.errors = report.errors.length
    }
  } catch {}

  // ---- catalogue lookup: price, stock, basic/extended ---------------------
  if (!opts.noParts && report.bom.some((l) => l.lcsc)) {
    progress("analyze", 0.82, "Checking part prices and stock")
    const info = await lookupParts(report.bom.flatMap((l) => (l.lcsc ? [l.lcsc] : []))).catch(() => ({}) as Record<string, any>)
    let cost = 0
    let priced = 0
    let extended = 0
    for (const line of report.bom) {
      const part = line.lcsc ? info[line.lcsc] : undefined
      if (!part) continue
      line.unitPrice = part.price
      line.stock = part.stock
      line.basic = part.basic
      line.partDescription = part.description
      if (!line.mpn) line.mpn = part.mpn
      if (!line.footprint) line.footprint = part.package
      if (part.price != null) {
        cost += part.price * line.qty
        priced++
      }
      if (!part.basic) extended++
      if (part.stock != null && part.stock < Math.max(50, line.qty * 20))
        report.warnings.push({
          severity: "warning",
          code: "bom_low_stock",
          message: `${line.designators.join(", ")}: ${part.mpn} (${line.lcsc}) has only ${part.stock} in stock at JLCPCB.`,
          components: line.designators,
          hint: "Pick a well-stocked equivalent with search_parts (prefer basic parts) and set supplierPartNumbers={{ jlcpcb: [\"C...\"] }}.",
        })
    }
    report.summary.bomCostUsd = priced ? Math.round(cost * 1000) / 1000 : null
    report.summary.extendedParts = extended
    report.summary.warnings = report.warnings.length
    if (report.status === "pass" && report.warnings.length) report.status = "warnings"
  }

  // ---- render ----------------------------------------------------------
  progress("render", 0.88, "Rendering schematic and PCB previews")
  const renders: [string, string, () => string][] = [
    ["schematicSvg", "schematic.svg", () => convertCircuitJsonToSchematicSvg(circuitJson as any)],
    ["pcbSvg", "pcb.svg", () => convertCircuitJsonToPcbSvg(circuitJson as any)],
    ["assemblySvg", "assembly.svg", () => convertCircuitJsonToAssemblySvg(circuitJson as any)],
  ]
  await fs.rm(path.join(out, "simulation.svg"), { force: true })
  const experiment = circuitJson.find((e) => e.type === "simulation_experiment")
  if (experiment && report.simulation)
    renders.push([
      "simulationSvg",
      "simulation.svg",
      () => (convertCircuitJsonToSimulationGraphSvg as any)({ circuitJson, simulation_experiment_id: experiment.simulation_experiment_id }),
    ])
  for (const [key, file, fn] of renders) {
    try {
      await fs.writeFile(path.join(out, file), fn())
      artifacts[key] = `.aeda/${file}`
    } catch (e: any) {
      report.info.push({ severity: "info", code: "render_failed", message: `${file}: ${e?.message ?? e}` })
    }
  }

  const result: BuildResult = { ...report, project: id, durationMs: Date.now() - started, artifacts }
  const v = await snapshot(id, opts.message ?? "build", report.status)
  result.version = v.version
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify(result, null, 2))
  await touchProject(id)
  progress("done", 1, report.ok ? "Build passed" : `Build finished with ${report.errors.length} error(s)`)
  return result
}

export async function readReport(id: string): Promise<BuildResult | null> {
  requireProject(id)
  const f = path.join(buildDir(id), "report.json")
  if (!existsSync(f)) return null
  return JSON.parse(await fs.readFile(f, "utf8"))
}

export async function readCircuitJson(id: string): Promise<any[]> {
  requireProject(id)
  const f = path.join(buildDir(id), "circuit.json")
  if (!existsSync(f))
    throw new EdaError("not_built", `Project "${id}" has no successful build yet`, "Call build first and fix compile errors.")
  return JSON.parse(await fs.readFile(f, "utf8"))
}

const NOTABLE_INFO = new Set(["power_trace_thin", "silkscreen_overlap"])

/** Trim a report for LLM consumption: caps long lists, drops per-component detail unless asked. */
export function compactReport(r: BuildResult, opts: { detail?: boolean } = {}) {
  const cap = <T>(a: T[], n: number) => (a.length > n ? [...a.slice(0, n), `... ${a.length - n} more` as any] : a)
  const base: any = {
    project: r.project,
    version: r.version,
    ok: r.ok,
    status: r.status,
    durationMs: r.durationMs,
    summary: r.summary,
    errors: cap(r.errors, 25),
    warnings: cap(r.warnings, 25),
    infoCount: r.info.length,
    // Advisory findings an engineer should still weigh; everything else in `info` is style.
    notes: r.info.filter((d) => NOTABLE_INFO.has(d.code)).map((d) => ({ code: d.code, message: d.message, hint: d.hint })),
  }
  if (r.compileError) base.compileError = { ...r.compileError, stack: undefined }
  // Where to look: vector previews written by every successful compile (use `render` for a PNG).
  const previews = Object.entries(r.artifacts ?? {})
    .filter(([k]) => /Svg$/.test(k))
    .map(([, v]) => v)
  if (previews.length) base.previews = previews
  if (r.simulation)
    base.simulation = {
      experiments: r.simulation.experiments,
      probes: r.simulation.probes.map(({ points: _points, ...stats }) => stats),
    }
  const dfmFails = r.dfm?.rules.filter((x) => x.status === "fail" || x.status === "marginal")
  if (dfmFails?.length) base.dfm = dfmFails
  if (opts.detail) {
    base.components = r.components
    base.nets = r.nets
    base.bom = r.bom
    base.info = cap(r.info, 30)
  }
  base.next = r.ok
    ? r.warnings.length
      ? "Build is fab-ready. Review warnings (unsourced BOM parts matter only for assembly), then export_fab."
      : "Build is clean. Call export_fab to produce Gerber/BOM/CPL."
    : "Fix the errors (see hint on each), edit the source, and build again."
  return base
}
