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
  listVersions,
  readMeta,
  readProjectFile,
  restoreVersion,
  writeProjectFile,
  ENTRY,
  EdaError,
} from "./engine/project"
import { buildProject, compactReport, readReport, type BuildProgress } from "./engine/build"
import { exportFab, export3d } from "./engine/export"
import { importPart, searchParts } from "./engine/parts"
import { GUIDE } from "./guide"

export interface ToolContext {
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
    name: "create_project",
    title: "Create project",
    description: `Create a new PCB project. Optionally pass the full ${ENTRY} source as \`code\`; otherwise a starter LED board is written. Returns the project id. Follow with build.`,
    shape: {
      name: z.string().describe("Human-readable project name, e.g. 'USB-C LED torch'"),
      description: z.string().optional().describe("What the board is for; the product requirement in one or two sentences"),
      code: z.string().optional().describe(`Initial contents of ${ENTRY}`),
    },
    handler: async (a, ctx) => {
      const meta = await createProject(a)
      ctx.onChange?.(meta.id, "project")
      return { project: meta.id, entry: ENTRY, next: "Write the design to the entry file (write_file), then call build." }
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
    name: "build",
    title: "Build and check",
    description:
      "Compile the project: places parts, autoroutes traces, matches JLCPCB parts, then runs ERC/DRC. Returns a report with summary numbers plus errors and warnings, each with a fix hint. This is the verification loop: edit -> build -> read errors -> repeat until ok is true. Takes 5-60 s.",
    shape: {
      project,
      detail: z.boolean().optional().describe("Also return full component list (with pin names and placed positions), netlist and BOM"),
      no_parts: z.boolean().optional().describe("Skip the online JLCPCB part lookup (faster, offline)"),
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
      "Produce the JLCPCB order files from the last build: gerbers.zip, bom.csv, cpl.csv, plus KiCad files and one bundle zip. Refuses if the last build has errors unless force is set.",
    shape: { project, force: z.boolean().optional() },
    handler: async (a, ctx) => {
      const r = await exportFab(a.project, { force: a.force })
      ctx.onChange?.(a.project, "export")
      return r
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
  try {
    return { ok: true, result: await tool.handler(parsed.data, ctx) }
  } catch (e: any) {
    if (e instanceof EdaError) return { ok: false, result: { error: { code: e.code, message: e.message, hint: e.hint } } }
    return { ok: false, result: { error: { code: "internal_error", message: String(e?.message ?? e) } } }
  }
}
