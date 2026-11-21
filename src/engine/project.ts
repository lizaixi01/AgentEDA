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
  if (path.relative(dir, full).split(path.sep)[0] === ".aeda")
    throw new EdaError("bad_path", `".aeda" holds generated build output and is read-only`)
  return full
}

const STARTER = `// Entry file: default-export a <board>. Units are mm; board centre is (0, 0).
// Leave pcbX/pcbY off and parts are auto-placed; traces are auto-routed.
export default () => (
  <board width="20mm" height="15mm">
    <resistor name="R1" resistance="1k" footprint="0402" />
    <led name="D1" color="red" footprint="0603" />
    <pinheader name="J1" pinCount={2} pitch="2.54mm" pinLabels={["VCC", "GND"]} />

    <trace from=".J1 > .VCC" to=".R1 > .pin1" />
    <trace from=".R1 > .pin2" to=".D1 > .anode" />
    <trace from=".D1 > .cathode" to=".J1 > .GND" />
  </board>
)
`

export async function createProject(opts: { name: string; description?: string; code?: string; id?: string }) {
  await fs.mkdir(PROJECTS_DIR, { recursive: true })
  let id = opts.id ? slugify(opts.id) : slugify(opts.name)
  const base = id
  for (let n = 2; existsSync(projectDir(id)); n++) id = `${base}-${n}`
  const dir = projectDir(id)
  await fs.mkdir(path.join(dir, "lib"), { recursive: true })
  const now = new Date().toISOString()
  const meta: ProjectMeta = {
    id,
    name: opts.name,
    description: opts.description ?? "",
    createdAt: now,
    updatedAt: now,
  }
  await fs.writeFile(path.join(dir, "aeda.json"), JSON.stringify(meta, null, 2))
  await fs.writeFile(path.join(dir, ENTRY), opts.code ?? STARTER)
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
      let status: string | undefined
      const reportFile = path.join(PROJECTS_DIR, name, ".aeda", "report.json")
      if (existsSync(reportFile)) status = JSON.parse(await fs.readFile(reportFile, "utf8")).status
      out.push({ ...meta, status })
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
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
  await touchProject(id)
  return { path: rel, bytes: Buffer.byteLength(content) }
}

/** Exact-string replace, like an editor tool. Fails loudly when the match is missing or ambiguous. */
export async function editProjectFile(id: string, rel: string, oldStr: string, newStr: string, replaceAll = false) {
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
  for (const f of files) payload[f.path] = await fs.readFile(path.join(projectDir(id), f.path), "utf8")
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
    const full = path.join(dir, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  await touchProject(id)
  return { restored: version, files: Object.keys(payload).length }
}
