/** Append-only activity feed per project: every mutating tool call, from any interface. */
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { PROJECTS_DIR } from "./project"

export interface ActivityEntry {
  at: string
  source: string
  tool: string
  ok: boolean
  summary: string
  durationMs: number
}

function file(id: string) {
  return path.join(PROJECTS_DIR, id, ".aeda", "activity.jsonl")
}

export async function logActivity(id: string, e: Omit<ActivityEntry, "at">) {
  try {
    if (!existsSync(path.join(PROJECTS_DIR, id, "aeda.json"))) return
    await fs.mkdir(path.dirname(file(id)), { recursive: true })
    await fs.appendFile(file(id), JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n")
  } catch {}
}

export async function readActivity(id: string, limit = 100): Promise<ActivityEntry[]> {
  const f = file(id)
  if (!existsSync(f)) return []
  const lines = (await fs.readFile(f, "utf8")).trim().split("\n").filter(Boolean)
  // One damaged line (a write cut short) must not take the whole project page down.
  const out: ActivityEntry[] = []
  for (const l of lines) {
    try {
      const e = JSON.parse(l)
      if (e && typeof e === "object") out.push(e)
    } catch {}
  }
  return out.slice(-limit)
}
