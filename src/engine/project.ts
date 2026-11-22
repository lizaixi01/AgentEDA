/**
 * Project store. A project is a plain folder:
 *
 *   projects/<id>/
 *     aeda.json            metadata (name, description, timestamps)
 *     index.circuit.tsx    entry: default-exports a tscircuit <board>
 *     lib/*.tsx            imported / custom parts
 *     .aeda/               build outputs + version history (generated)
 */
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"

export const ROOT = path.resolve(import.meta.dir, "../..")
export const PROJECTS_DIR = process.env.AEDA_PROJECTS_DIR
  ? path.resolve(process.env.AEDA_PROJECTS_DIR)
  : path.join(ROOT, "projects")
export const ENTRY = "index.circuit.tsx"

export interface ProjectMeta {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export class EdaError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message)
  }
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return s || `board-${Date.now().toString(36)}`
}

export function projectDir(id: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new EdaError("bad_project_id", `Invalid project id "${id}"`)
  return path.join(PROJECTS_DIR, id)
}

export function buildDir(id: string): string {
  return path.join(projectDir(id), ".aeda")
}

export function requireProject(id: string): string {
  const dir = projectDir(id)
  if (!existsSync(path.join(dir, "aeda.json")))
    throw new EdaError("project_not_found", `Project "${id}" does not exist`, "Call list_projects, or create_project first.")
  return dir
}

/** Resolve a user-supplied relative path inside a project, refusing escapes. */
export function safePath(id: string, rel: string): string {
  const dir = projectDir(id)
  const full = path.resolve(dir, rel)
  if (full !== dir && !full.startsWith(dir + path.sep))
    throw new EdaError("bad_path", `Path "${rel}" escapes the project folder`)
  // Compared case-insensitively: the default macOS filesystem treats ".AEDA" as the same folder.
  if (path.relative(dir, full).split(path.sep)[0]?.toLowerCase() === ".aeda")
    throw new EdaError("bad_path", `".aeda" holds generated build output and is read-only`)
  return full
}

const STARTER = `// Entry file: default-export a <board>. Units are mm; board centre is (0, 0).
// Leave pcbX/pcbY off and parts are auto-placed; traces are auto-routed.
export default () => (
  <board width="20mm" height="15mm">
    <resistor name="R1" resistance="1k" footprint="0402" />
    <led name="D1" color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} />
    <pinheader name="J1" pinCount={2} pitch="2.54mm" pinLabels={["VCC", "GND"]} />

    <trace from="J1.VCC" to="R1.pin1" />
    <trace from="R1.pin2" to="D1.anode" />
    <trace from="D1.cathode" to="J1.GND" />
  </board>
)
`

// ---- templates -------------------------------------------------------------

export const TEMPLATES_DIR = path.join(ROOT, "templates")

export interface TemplateInfo {
  id: string
  name: string
  description: string
  tags: string[]
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  if (!existsSync(TEMPLATES_DIR)) return []
  const out: (TemplateInfo & { order: number })[] = []
  for (const id of await fs.readdir(TEMPLATES_DIR)) {
    const f = path.join(TEMPLATES_DIR, id, "template.json")
    if (!existsSync(f) || !existsSync(path.join(TEMPLATES_DIR, id, ENTRY))) continue
    try {
      const t = JSON.parse(await fs.readFile(f, "utf8"))
      out.push({ id, name: t.name ?? id, description: t.description ?? "", tags: t.tags ?? [], order: t.order ?? 99 })
    } catch {}
  }
  return out.sort((a, b) => a.order - b.order).map(({ order: _o, ...t }) => t)
}

async function copyTemplate(templateId: string, dir: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(templateId) || !existsSync(path.join(TEMPLATES_DIR, templateId, ENTRY)))
    throw new EdaError("template_not_found", `No template "${templateId}"`, "Call list_templates.")
  const src = path.join(TEMPLATES_DIR, templateId)
  async function walk(rel: string) {
    for (const ent of await fs.readdir(path.join(src, rel), { withFileTypes: true })) {
      if (ent.name === "template.json") continue
      const r = path.join(rel, ent.name)
      if (ent.isDirectory()) {
        await fs.mkdir(path.join(dir, r), { recursive: true })
        await walk(r)
      } else await fs.copyFile(path.join(src, r), path.join(dir, r))
    }
  }
  await walk("")
}

export async function createProject(opts: { name?: string; description?: string; code?: string; id?: string; template?: string }) {
  let template: TemplateInfo | undefined
  if (opts.template) {
    template = (await listTemplates()).find((t) => t.id === opts.template)
    if (!template) throw new EdaError("template_not_found", `No template "${opts.template}"`, "Call list_templates.")
  }
  const name = opts.name?.trim() || template?.name || "Untitled board"
  await fs.mkdir(PROJECTS_DIR, { recursive: true })
  let id = opts.id ? slugify(opts.id) : slugify(template && !opts.name ? template.id : name)
  const base = id
  for (let n = 2; existsSync(projectDir(id)); n++) id = `${base}-${n}`
  const dir = projectDir(id)
  await fs.mkdir(path.join(dir, "lib"), { recursive: true })
  const now = new Date().toISOString()
  const meta: ProjectMeta = {
    id,
    name,
    description: opts.description ?? template?.description ?? "",
    createdAt: now,
    updatedAt: now,
  }
  await fs.writeFile(path.join(dir, "aeda.json"), JSON.stringify(meta, null, 2))
  if (template) await copyTemplate(template.id, dir)
  if (opts.code || !template) await fs.writeFile(path.join(dir, ENTRY), opts.code ?? STARTER)
  return meta
}

export async function readMeta(id: string): Promise<ProjectMeta> {
  const dir = requireProject(id)
  return JSON.parse(await fs.readFile(path.join(dir, "aeda.json"), "utf8"))
}

export async function touchProject(id: string, patch: Partial<ProjectMeta> = {}) {
  const meta = await readMeta(id)
  const next = { ...meta, ...patch, id: meta.id, updatedAt: new Date().toISOString() }
  await fs.writeFile(path.join(projectDir(id), "aeda.json"), JSON.stringify(next, null, 2))
  return next
}

export async function listProjects(): Promise<(ProjectMeta & { status?: string })[]> {
  if (!existsSync(PROJECTS_DIR)) return []
  const out: (ProjectMeta & { status?: string })[] = []
  for (const name of await fs.readdir(PROJECTS_DIR)) {
    const metaFile = path.join(PROJECTS_DIR, name, "aeda.json")
    if (!existsSync(metaFile)) continue
    try {
      const meta = JSON.parse(await fs.readFile(metaFile, "utf8"))
      if (!meta || typeof meta !== "object") continue
      let status: string | undefined
      const reportFile = path.join(PROJECTS_DIR, name, ".aeda", "report.json")
      if (existsSync(reportFile)) status = JSON.parse(await fs.readFile(reportFile, "utf8")).status
      // The folder name is the id, whatever the file says.
      out.push({ ...meta, id: name, status })
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function deleteProject(id: string) {
  const dir = requireProject(id)
  await fs.rm(dir, { recursive: true, force: true })
}

export async function listFiles(id: string): Promise<{ path: string; bytes: number }[]> {
  const dir = requireProject(id)
  const out: { path: string; bytes: number }[] = []
  async function walk(d: string) {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      if (ent.name === ".aeda" || ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) await walk(full)
      else out.push({ path: path.relative(dir, full), bytes: (await fs.stat(full)).size })
    }
  }
  await walk(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function readProjectFile(id: string, rel: string): Promise<string> {
  requireProject(id)
  const full = safePath(id, rel)
  if (!existsSync(full))
    throw new EdaError("file_not_found", `No file "${rel}" in project "${id}"`, "Call list_files to see what exists.")
  return fs.readFile(full, "utf8")
}

export async function writeProjectFile(id: string, rel: string, content: string) {
  requireProject(id)
  const full = safePath(id, rel)
  // Not writable through the tools: project metadata, dotfiles, and files that would change how
  // the design is executed when it is built (runtime config, package manifests, dependencies).
  const inside = path.relative(projectDir(id), full)
  const first = (inside.split(path.sep)[0] ?? "").toLowerCase()
  if (first.startsWith(".") || first === "node_modules" || /^(aeda\.json|bunfig\.toml|package\.json|tsconfig\.json)$/i.test(inside))
    throw new EdaError("bad_path", `"${rel}" is reserved and cannot be written`, "Design files are .tsx files (plus NOTES.md). The project name and description are changed in the app.")
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
  await touchProject(id)
  return { path: rel, bytes: Buffer.byteLength(content) }
}

/** Exact-string replace, like an editor tool. Fails loudly when the match is missing or ambiguous. */
export async function editProjectFile(id: string, rel: string, oldStr: string, newStr: string, replaceAll = false) {
  if (oldStr === "")
    throw new EdaError("edit_no_match", "old_string is empty", "Pass the exact text to replace; use write_file to replace the whole file.")
  const content = await readProjectFile(id, rel)
  const count = content.split(oldStr).length - 1
  if (count === 0)
    throw new EdaError("edit_no_match", `old_string not found in ${rel}`, "Read the file again; the text must match exactly, including whitespace.")
  if (count > 1 && !replaceAll)
    throw new EdaError("edit_ambiguous", `old_string matches ${count} places in ${rel}`, "Include more surrounding context, or pass replace_all.")
  const next = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr)
  await writeProjectFile(id, rel, next)
  return { path: rel, replacements: replaceAll ? count : 1 }
}

// ---- version history -----------------------------------------------------

export interface VersionInfo {
  version: number
  message: string
  createdAt: string
  status?: string
}

async function readVersions(id: string): Promise<VersionInfo[]> {
  const f = path.join(buildDir(id), "history", "versions.json")
  if (!existsSync(f)) return []
  return JSON.parse(await fs.readFile(f, "utf8"))
}

export async function listVersions(id: string) {
  requireProject(id)
  return readVersions(id)
}

/** Snapshot all source files. Called after every build so any state can be restored. */
export async function snapshot(id: string, message: string, status?: string): Promise<VersionInfo> {
  const versions = await readVersions(id)
  const files = await listFiles(id)
  const payload: Record<string, string> = {}
  // aeda.json only carries timestamps and the name; it is not part of the design.
  for (const f of files) if (f.path !== "aeda.json") payload[f.path] = await fs.readFile(path.join(projectDir(id), f.path), "utf8")
  const serialized = JSON.stringify(payload)
  const histDir = path.join(buildDir(id), "history")
  await fs.mkdir(histDir, { recursive: true })
  // Identical to the latest snapshot: just refresh its status instead of piling up duplicates.
  const last = versions[versions.length - 1]
  if (last) {
    const lastFile = path.join(histDir, `v${last.version}.json`)
    if (existsSync(lastFile) && (await fs.readFile(lastFile, "utf8")) === serialized) {
      last.status = status
      await fs.writeFile(path.join(histDir, "versions.json"), JSON.stringify(versions, null, 2))
      return last
    }
  }
  const info: VersionInfo = {
    version: (last?.version ?? 0) + 1,
    message,
    createdAt: new Date().toISOString(),
    status,
  }
  await fs.writeFile(path.join(histDir, `v${info.version}.json`), serialized)
  versions.push(info)
  await fs.writeFile(path.join(histDir, "versions.json"), JSON.stringify(versions, null, 2))
  return info
}

export async function restoreVersion(id: string, version: number) {
  const dir = requireProject(id)
  const f = path.join(buildDir(id), "history", `v${version}.json`)
  if (!existsSync(f)) throw new EdaError("version_not_found", `Version ${version} does not exist`, "Call list_versions.")
  const payload: Record<string, string> = JSON.parse(await fs.readFile(f, "utf8"))
  for (const existing of await listFiles(id)) {
    if (existing.path === "aeda.json") continue
    if (!(existing.path in payload)) await fs.rm(path.join(dir, existing.path))
  }
  for (const [rel, content] of Object.entries(payload)) {
    if (rel === "aeda.json") continue
    const full = safePath(id, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  await touchProject(id)
  return { restored: version, files: Object.keys(payload).length }
}


// ---- structured placement edit ----------------------------------------------

/**
 * Set pcbX / pcbY / pcbRotation / layer on the JSX element whose name prop is `name`.
 * Works on literal names (name="R1"). Parts generated in a loop have no single element to edit.
 */
export async function placeComponent(
  id: string,
  name: string,
  place: { x?: number; y?: number; rotation?: number; layer?: "top" | "bottom" },
) {
  if (!/^[A-Za-z_][\w-]*$/.test(name)) throw new EdaError("bad_component_name", `"${name}" is not a valid designator`)
  const files = (await listFiles(id)).filter((f) => /\.tsx$/.test(f.path) && !f.path.startsWith("lib/"))
  // Brace groups and quoted strings are consumed whole, so a ">" inside a prop value can never close the tag.
  const attrRun = `(?:\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\}|"[^"]*"|'[^']*'|[^<>{}"'])*?`
  const tagRe = new RegExp(`<([A-Za-z_][\\w.]*)(${attrRun}\\bname=(?:"${name}"|'${name}'|\\{"${name}"\\})${attrRun})(/?>)`)
  for (const f of files) {
    const source = await readProjectFile(id, f.path)
    const m = source.match(tagRe)
    if (!m) continue
    let attrs = m[2]!
    const setProp = (prop: string, value: string | undefined) => {
      if (value === undefined) return
      const re = new RegExp(`\\s${prop}=(?:\\{[^{}]*\\}|"[^"]*")`)
      if (re.test(attrs)) attrs = attrs.replace(re, ` ${prop}=${value}`)
      else attrs = attrs.replace(/\s*$/, "") + ` ${prop}=${value}` + (m[3] === "/>" ? " " : "")
    }
    const num = (n: number | undefined) => (n === undefined ? undefined : `{${Math.round(n * 1000) / 1000}}`)
    setProp("pcbX", num(place.x))
    setProp("pcbY", num(place.y))
    setProp("pcbRotation", num(place.rotation))
    setProp("layer", place.layer ? `"${place.layer}"` : undefined)
    // Function form: "$" sequences in the attributes must not be read as replacement patterns.
    const next = source.replace(m[0]!, () => `<${m[1]}${attrs}${m[3]}`)
    await writeProjectFile(id, f.path, next)
    return { component: name, element: m[1], file: f.path, ...place }
  }
  throw new EdaError(
    "component_not_found",
    `No element with name="${name}" in the design sources`,
    "Only parts written with a literal name can be placed this way. For parts generated in a loop or inside a reusable component, edit the code.",
  )
}
