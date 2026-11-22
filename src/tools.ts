/**
 * The single tool surface of AgentEDA. CLI, MCP server, HTTP API and the built-in chat agent
 * are all thin adapters over this table, so every interface behaves identically.
 *
 * Design rules for agent-friendliness:
 *  - every tool returns JSON; errors are { error: { code, message, hint } }
 *  - results say what to do next (`next`, `hint`)
 *  - outputs are size-capped; detail is opt-in
 */
import { z } from "zod"
import {
  createProject,
  deleteProject,
  editProjectFile,
  listFiles,
  listProjects,
  listTemplates,
  listVersions,
  placeComponent,
  readMeta,
  readProjectFile,
  restoreVersion,
  writeProjectFile,
  ENTRY,
  EdaError,
} from "./engine/project"
import { buildProject, compactReport, readReport, type BuildProgress } from "./engine/build"
import { exportFab, export3d } from "./engine/export"
import { exportReport } from "./engine/report"
import { PART_CATEGORIES, browseParts, importPart, searchParts } from "./engine/parts"
import path from "node:path"
import fs from "node:fs/promises"
import { renderPng } from "./engine/render"
import { buildDir } from "./engine/project"
import { GUIDE } from "./guide"
import { logActivity } from "./engine/activity"

export interface ToolContext {
  /** Which interface the call came through; recorded in the project's activity feed */
  source?: "cli" | "mcp" | "http" | "agent" | "web"
  onProgress?: (p: BuildProgress) => void
  /** Notified after anything that changes what the UI should show */
  onChange?: (project: string, kind: "files" | "build" | "export" | "project") => void
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  shape: S
  readOnly?: boolean
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>
}

function def<S extends z.ZodRawShape>(t: ToolDef<S>): ToolDef<any> {
  return t as any
}

const project = z.string().describe("Project id (from list_projects / create_project)")

export const tools: ToolDef<any>[] = [
  def({
    name: "get_guide",
    title: "Design guide",
    description:
      "Returns the AgentEDA design guide: the tscircuit TSX syntax for boards, parts, nets and traces, footprint names, the build/fix loop, and worked examples. Read this once before writing a design.",
    shape: {},
    readOnly: true,
    handler: async () => ({ guide: GUIDE }),
  }),
  def({
    name: "list_projects",
    title: "List projects",
    description: "List all PCB projects with their last build status.",
    shape: {},
    readOnly: true,
    handler: async () => ({ projects: await listProjects() }),
  }),
  def({
    name: "list_templates",
    title: "List templates",
    description: "List ready-made, verified board designs that can be used as a starting point (create_project with template).",
    shape: {},
    readOnly: true,
    handler: async () => ({ templates: await listTemplates() }),
  }),
  def({
    name: "create_project",
    title: "Create project",
    description: `Create a new PCB project. Pass the full ${ENTRY} source as \`code\`, or a \`template\` id to start from a verified design; otherwise a starter LED board is written. Returns the project id. Follow with build.`,
    shape: {
      name: z.string().optional().describe("Human-readable project name, e.g. 'USB-C LED torch'. Optional when a template is given"),
      template: z.string().optional().describe("Start from a verified template (id from list_templates) instead of the starter board"),
      description: z.string().optional().describe("What the board is for; the product requirement in one or two sentences"),
      code: z.string().optional().describe(`Initial contents of ${ENTRY}`),
    },
    handler: async (a, ctx) => {
      if (!a.name && !a.template) throw new EdaError("invalid_arguments", "Give a name or a template")
      const meta = await createProject(a)
      ctx.onChange?.(meta.id, "project")
      return {
        project: meta.id,
        name: meta.name,
        entry: ENTRY,
        next: a.template ? "Call build, then read_file to see the design." : "Write the design to the entry file (write_file), then call build.",
      }
    },
  }),
  def({
    name: "delete_project",
    title: "Delete project",
    description: "Permanently delete a project folder, including its history.",
    shape: { project },
    handler: async (a, ctx) => {
      await deleteProject(a.project)
      ctx.onChange?.(a.project, "project")
      return { deleted: a.project }
    },
  }),
  def({
    name: "list_files",
    title: "List files",
    description: "List source files in a project.",
    shape: { project },
    readOnly: true,
    handler: async (a) => ({ project: a.project, meta: await readMeta(a.project), files: await listFiles(a.project) }),
  }),
  def({
    name: "read_file",
    title: "Read file",
    description: `Read a source file from a project (default: ${ENTRY}).`,
    shape: { project, path: z.string().optional().describe(`Path relative to the project, default ${ENTRY}`) },
    readOnly: true,
    handler: async (a) => {
      const rel = a.path ?? ENTRY
      return { path: rel, content: await readProjectFile(a.project, rel) }
    },
  }),
  def({
    name: "write_file",
    title: "Write file",
    description: `Create or overwrite a source file. The design entry is ${ENTRY} and must default-export a component returning <board>. Does not build; call build afterwards.`,
    shape: {
      project,
      path: z.string().optional().describe(`Path relative to the project, default ${ENTRY}`),
      content: z.string().describe("Full file contents"),
    },
    handler: async (a, ctx) => {
      const r = await writeProjectFile(a.project, a.path ?? ENTRY, a.content)
      ctx.onChange?.(a.project, "files")
      return { ...r, next: "Call build to compile and check." }
    },
  }),
  def({
    name: "edit_file",
    title: "Edit file",
    description: "Replace an exact string in a source file. Prefer this over write_file for small changes. Fails if old_string is missing or ambiguous.",
    shape: {
      project,
      path: z.string().optional().describe(`Path relative to the project, default ${ENTRY}`),
      old_string: z.string().describe("Exact text to replace"),
      new_string: z.string().describe("Replacement text"),
      replace_all: z.boolean().optional(),
    },
    handler: async (a, ctx) => {
      const r = await editProjectFile(a.project, a.path ?? ENTRY, a.old_string, a.new_string, a.replace_all)
      ctx.onChange?.(a.project, "files")
      return { ...r, next: "Call build to compile and check." }
    },
  }),
  def({
    name: "place_component",
    title: "Place component",
    description:
      "Set a part's PCB position without rewriting code: updates pcbX / pcbY (mm, board centre is 0,0), pcbRotation (degrees) and layer on the element with that name. Give only the fields you want to change. Call build afterwards. Positions of placed parts are in build's detail output (components[].x/y/rotation).",
    shape: {
      project,
      name: z.string().describe("Designator, e.g. U1, C3, J2"),
      x: z.number().optional().describe("pcbX in mm"),
      y: z.number().optional().describe("pcbY in mm"),
      rotation: z.number().optional().describe("pcbRotation in degrees"),
      layer: z.enum(["top", "bottom"]).optional(),
    },
    handler: async (a, ctx) => {
      if (a.x === undefined && a.y === undefined && a.rotation === undefined && a.layer === undefined)
        throw new EdaError("invalid_arguments", "Give at least one of x, y, rotation, layer")
      const r = await placeComponent(a.project, a.name, { x: a.x, y: a.y, rotation: a.rotation, layer: a.layer })
      ctx.onChange?.(a.project, "files")
      return { ...r, next: "Call build to re-route with the new placement." }
    },
  }),
  def({
    name: "build",
    title: "Build and check",
    description:
      "Compile the project: places parts, autoroutes traces, matches JLCPCB parts, then runs ERC/DRC. Returns a report with summary numbers plus errors and warnings, each with a fix hint. This is the verification loop: edit -> build -> read errors -> repeat until ok is true. Takes 5-60 s.",
    shape: {
      project,
      detail: z.boolean().optional().describe("Also return full component list (with pin names and placed positions), netlist and BOM"),
      no_parts: z.boolean().optional().describe("Skip the online JLCPCB part lookup (faster, offline). Do not use with <connector standard=...> or jlcpcb: footprints, which need the lookup"),
      message: z.string().optional().describe("Short label for this version in the history, e.g. 'add USB-C connector'"),
    },
    handler: async (a, ctx) => {
      const r = await buildProject(a.project, { noParts: a.no_parts, message: a.message, onProgress: ctx.onProgress })
      ctx.onChange?.(a.project, "build")
      return compactReport(r, { detail: a.detail })
    },
  }),
  def({
    name: "get_report",
    title: "Get last report",
    description: "Return the report of the last build without rebuilding. Use detail=true for the component list (pin names, positions), netlist and BOM.",
    shape: { project, detail: z.boolean().optional() },
    readOnly: true,
    handler: async (a) => {
      const r = await readReport(a.project)
      if (!r) throw new EdaError("not_built", `Project "${a.project}" has not been built`, "Call build.")
      return compactReport(r, { detail: a.detail ?? true })
    },
  }),
  def({
    name: "search_parts",
    title: "Search parts",
    description:
      "Search the JLCPCB/LCSC catalogue for in-stock parts. Returns LCSC numbers, package, stock, unit price and whether the part is 'basic' (no extended assembly fee). Query by part number or keywords, e.g. 'AMS1117-3.3', 'USB-C 16pin', 'ESP32-C3'.",
    shape: {
      query: z.string(),
      package: z.string().optional().describe("Package filter, e.g. SOT-223, 0603, QFN-32"),
      limit: z.number().int().min(1).max(50).optional(),
      basic_only: z.boolean().optional(),
    },
    readOnly: true,
    handler: async (a) => searchParts({ query: a.query, package: a.package, limit: a.limit, basicOnly: a.basic_only }),
  }),
  def({
    name: "browse_parts",
    title: "Browse parts by category",
    description:
      `List in-stock JLCPCB parts of one category with their attributes, best (basic, deep stock) first. Use this when you know the kind of part but not a part number, e.g. a green 0603 LED, a 2-pin JST PH socket, a 3.3 V LDO, a slide switch. \`where\` filters on exact attribute values ("color=green", "num_pins=2,pitch_mm=2"); \`contains\` filters on words in the part number / description. The result lists \`filterableAttributes\` for the category. Categories: ${PART_CATEGORIES.join(", ")}.`,
    shape: {
      category: z.string().describe("One of the categories listed in the description"),
      package: z.string().optional().describe("Exact package, e.g. 0603, SOT-23, SOT-223"),
      where: z.string().optional().describe('Exact attribute filters as "key=value,key=value"'),
      contains: z.string().optional().describe("Words that must appear in the part number or description"),
      basic_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(40).optional(),
    },
    readOnly: true,
    handler: async (a) => browseParts({ category: a.category, package: a.package, where: a.where, contains: a.contains, basicOnly: a.basic_only, limit: a.limit }),
  }),
  def({
    name: "import_part",
    title: "Import part",
    description:
      "Import an exact LCSC part (e.g. C6186) into the project as lib/<Name>.tsx with its real footprint, pin labels, 3D model and supplier number. Returns the import line, usage and pin names. Use for every IC, connector or module; generic passives do not need it.",
    shape: { project, lcsc: z.string().describe("LCSC part number, e.g. C6186") },
    handler: async (a, ctx) => {
      const r = await importPart(a.project, a.lcsc)
      ctx.onChange?.(a.project, "files")
      return r
    },
  }),
  def({
    name: "export_fab",
    title: "Export manufacturing files",
    description:
      "Produce the JLCPCB order files from the last build: gerbers.zip, bom.csv, cpl.csv, plus a STEP 3D model for mechanical CAD, KiCad files and one bundle zip. Refuses if the last build has errors unless force is set.",
    shape: { project, force: z.boolean().optional() },
    handler: async (a, ctx) => {
      const r = await exportFab(a.project, { force: a.force })
      ctx.onChange?.(a.project, "export")
      return r
    },
  }),
  def({
    name: "render",
    title: "Render view to PNG",
    description:
      "Rasterise a view of the last build to a PNG file and return its path, so you can look at the board: 'pcb' (copper, pads, silkscreen), 'schematic', 'assembly', or 'simulation' (waveforms). Open the returned file with your image-reading tool. (Over MCP this tool returns the image directly.)",
    shape: {
      project,
      view: z.enum(["pcb", "schematic", "assembly", "simulation"]).optional().describe("Default: pcb"),
      width: z.number().int().min(300).max(2400).optional().describe("Image width in px, default 1000"),
    },
    readOnly: true,
    handler: async (a) => {
      const view = a.view ?? "pcb"
      const png = await renderPng(a.project, view, a.width ?? 1000)
      const file = path.join(buildDir(a.project), `render-${view}.png`)
      await fs.writeFile(file, png)
      return { view, file, bytes: png.byteLength, note: "Board centre is (0,0); +x is right, +y is up. Red = top copper, blue = bottom copper, yellow = silkscreen." }
    },
  }),
  def({
    name: "export_report",
    title: "Export design report",
    description:
      "Write a self-contained HTML design report for human review (PCB and schematic images, design notes from NOTES.md, checks, manufacturability table, BOM, netlist, simulation). One offline file to send to a reviewer. Returns its path.",
    shape: { project },
    handler: async (a, ctx) => {
      const r = await exportReport(a.project)
      ctx.onChange?.(a.project, "export")
      return { ...r, next: "Give the file path to the user; it opens in any browser." }
    },
  }),
  def({
    name: "export_3d",
    title: "Export 3D model",
    description: "Write a GLB 3D model of the assembled board to .aeda/board.glb.",
    shape: { project },
    handler: async (a) => export3d(a.project),
  }),
  def({
    name: "list_versions",
    title: "List versions",
    description: "List the version history. Every build snapshots the sources.",
    shape: { project },
    readOnly: true,
    handler: async (a) => ({ project: a.project, versions: await listVersions(a.project) }),
  }),
  def({
    name: "restore_version",
    title: "Restore version",
    description: "Restore the project sources to an earlier version. Rebuild afterwards.",
    shape: { project, version: z.number().int() },
    handler: async (a, ctx) => {
      const r = await restoreVersion(a.project, a.version)
      ctx.onChange?.(a.project, "files")
      return { ...r, next: "Call build." }
    },
  }),
]

export const toolByName = new Map(tools.map((t) => [t.name, t]))

/**
 * Tools an agent gets when it is bound to one project (the built-in chat agent, and the MCP
 * server in pinned mode). The `project` argument is filled in for it.
 */
export const PROJECT_AGENT_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "place_component",
  "list_files",
  "build",
  "get_report",
  "search_parts",
  "browse_parts",
  "import_part",
  "export_fab",
  "export_report",
  "list_versions",
  "restore_version",
] as const

/** Uniform call wrapper: validates args, converts thrown errors into a structured error object. */
export async function callTool(name: string, args: unknown, ctx: ToolContext = {}): Promise<{ ok: boolean; result: any }> {
  const tool = toolByName.get(name)
  if (!tool)
    return {
      ok: false,
      result: { error: { code: "unknown_tool", message: `No tool "${name}"`, hint: `Available: ${tools.map((t) => t.name).join(", ")}` } },
    }
  const parsed = z.object(tool.shape).safeParse(args ?? {})
  if (!parsed.success)
    return {
      ok: false,
      result: {
        error: {
          code: "invalid_arguments",
          message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
          hint: `Expected: ${Object.keys(tool.shape).join(", ") || "no arguments"}`,
        },
      },
    }
  const started = Date.now()
  let out: { ok: boolean; result: any }
  try {
    out = { ok: true, result: await tool.handler(parsed.data, ctx) }
  } catch (e: any) {
    if (e instanceof EdaError) out = { ok: false, result: { error: { code: e.code, message: e.message, hint: e.hint } } }
    else
      out = {
        ok: false,
        result: {
          error: {
            code: "internal_error",
            message: String(e?.message ?? e),
            hint: "This is a fault in the tool or its environment, not in your design. Retry once; if it repeats, report the message to the user.",
          },
        },
      }
  }
  const projectId = (parsed.data as any).project ?? out.result?.project
  if (typeof projectId === "string" && !tool.readOnly && name !== "delete_project")
    await logActivity(projectId, {
      source: ctx.source ?? "cli",
      tool: name,
      ok: out.ok,
      summary: summarize(name, parsed.data, out),
      durationMs: Date.now() - started,
    })
  return out
}

/** One-line, human-readable description of what a tool call did (shown in the UI activity feed). */
export function summarize(name: string, args: any, out: { ok: boolean; result: any }): string {
  const r = out.result
  if (!out.ok) return `${r?.error?.code ?? "error"}: ${String(r?.error?.message ?? "").slice(0, 140)}`
  switch (name) {
    case "create_project":
      return `Created project ${r.project}`
    case "write_file":
      return `Wrote ${r.path} (${r.bytes} bytes)`
    case "edit_file":
      return `Edited ${r.path}`
    case "place_component":
      return `Moved ${r.component}${r.x !== undefined || r.y !== undefined ? ` to (${r.x ?? "="}, ${r.y ?? "="})` : ""}${r.rotation !== undefined ? ` rot ${r.rotation}°` : ""}${r.layer ? ` on ${r.layer}` : ""}`
    case "build": {
      const s = r.summary
      return r.status === "compile_failed"
        ? `Build v${r.version}: compile failed`
        : `Build v${r.version}: ${r.ok ? "passed" : "failed"}, ${s.errors} errors, ${s.warnings} warnings, routed ${s.connectionsRouted}/${s.connectionsTotal}`
    }
    case "import_part":
      return `Imported ${r.mpn} (${r.lcsc}) as ${r.component}`
    case "search_parts":
      return `Searched parts "${args.query}": ${r.count} hits`
    case "export_fab":
      return `Exported ${r.files.length} manufacturing files`
    case "export_report":
      return "Exported design report"
    case "export_3d":
      return `Exported 3D model`
    case "restore_version":
      return `Restored version ${r.restored}`
    default:
      return name
  }
}
