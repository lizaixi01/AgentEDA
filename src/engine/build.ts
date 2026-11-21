/**
 * build = compile (isolated subprocess) -> analyze (ERC/DRC/BOM) -> render previews.
 * Everything lands in <project>/.aeda/ so the web UI, CLI and MCP all read the same artifacts.
 */
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg, convertCircuitJsonToAssemblySvg } from "circuit-to-svg"
import { analyzeCircuitJson, type DesignReport, type Diagnostic } from "./analyze"
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

async function doBuild(id: string, opts: BuildOptions): Promise<BuildResult> {
  const dir = requireProject(id)
  const out = buildDir(id)
  await fs.mkdir(out, { recursive: true })
  const started = Date.now()
  const progress = (stage: BuildStage, p: number, message: string) => opts.onProgress?.({ stage, progress: p, message })

  const entry = path.join(dir, ENTRY)
  if (!existsSync(entry))
    throw new EdaError("no_entry", `Project "${id}" has no ${ENTRY}`, `Write the design to ${ENTRY} first.`)

  // ---- compile ---------------------------------------------------------
  progress("compile", 0.05, "Compiling circuit, placing parts and routing traces")
  const envelopeFile = path.join(out, "run.json")
  await fs.rm(envelopeFile, { force: true })
  const args = ["bun", "run", RUNNER, entry, envelopeFile]
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
  await fs.writeFile(path.join(out, "circuit.json"), JSON.stringify(circuitJson))
  artifacts.circuitJson = ".aeda/circuit.json"
  await fs.rm(envelopeFile, { force: true })

  // ---- analyze ---------------------------------------------------------
  progress("analyze", 0.75, "Running electrical and design rule checks")
  report = await analyzeCircuitJson(circuitJson)

  // ---- render ----------------------------------------------------------
  progress("render", 0.88, "Rendering schematic and PCB previews")
  const renders: [string, string, () => string][] = [
    ["schematicSvg", "schematic.svg", () => convertCircuitJsonToSchematicSvg(circuitJson as any)],
    ["pcbSvg", "pcb.svg", () => convertCircuitJsonToPcbSvg(circuitJson as any)],
    ["assemblySvg", "assembly.svg", () => convertCircuitJsonToAssemblySvg(circuitJson as any)],
  ]
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
  }
  if (r.compileError) base.compileError = { ...r.compileError, stack: undefined }
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
