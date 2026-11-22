// Typed client for the AgentEDA server. Mirrors src/engine types on the backend.
import { useEffect, useRef } from "react"

export type Severity = "error" | "warning" | "info"
export interface Diagnostic {
  severity: Severity
  code: string
  message: string
  components?: string[]
  at?: { x: number; y: number }
  hint?: string
}
export interface BomLine {
  designators: string[]
  qty: number
  kind: string
  value: string
  footprint: string
  mpn?: string
  lcsc?: string
  sourced: boolean
  unitPrice?: number | null
  stock?: number | null
  basic?: boolean
  partDescription?: string
}
export interface ComponentInfo {
  name: string
  kind: string
  value?: string
  footprint?: string
  mpn?: string
  lcsc?: string
  x?: number
  y?: number
  rotation?: number
  layer?: string
  pins: string[]
}
export interface Summary {
  board: { widthMm: number; heightMm: number; layers: number; thicknessMm: number } | null
  components: number
  nets: number
  pins: number
  traces: number
  vias: number
  traceLengthMm: number
  areaUsedPct?: number
  connectionsRouted: number
  connectionsTotal: number
  bomLines: number
  bomSourced: number
  bomCostUsd?: number | null
  extendedParts?: number
  errors: number
  warnings: number
}
export interface DfmRule {
  id: string
  label: string
  measured: number | null
  limit: number
  preferred?: number
  status: "pass" | "marginal" | "fail" | "n/a"
  blocking: boolean
  count: number
}
export interface ProbeStats {
  name: string
  experiment: string
  minV: number
  maxV: number
  meanV: number
  finalV: number
  peakToPeakV: number
  frequencyHz: number | null
  dutyCycle: number | null
  settled?: { minV: number; maxV: number; meanV: number; peakToPeakV: number }
  points: [number, number][]
}
export type BuildStatus = "pass" | "warnings" | "errors" | "compile_failed"
export interface Report {
  project: string
  version?: number
  ok: boolean
  status: BuildStatus
  durationMs: number
  summary: Summary
  errors: Diagnostic[]
  warnings: Diagnostic[]
  info: Diagnostic[]
  components: ComponentInfo[]
  nets: { name: string; pins: string[]; isPower?: boolean; isGround?: boolean; traceWidthMm?: number }[]
  bom: BomLine[]
  dfm?: { fab: string; rules: DfmRule[] }
  simulation?: { experiments: { name: string; durationMs: number }[]; probes: ProbeStats[] }
  artifacts: Record<string, string>
  compileError?: { phase: string; message: string; file?: string; line?: number }
}
export interface ProjectMeta {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  status?: BuildStatus
}
export interface VersionInfo {
  version: number
  message: string
  createdAt: string
  status?: string
}
export interface ActivityEntry {
  at: string
  source: string
  tool: string
  ok: boolean
  summary: string
  durationMs: number
}
export interface GerberVerification {
  ok: boolean
  parser: string
  layers: { file: string; type: string | null; side: string | null }[]
  missing: string[]
  sizeMm: { width: number; height: number } | null
  sizeMatchesDesign: boolean | null
  previews: string[]
  note?: string
}
export interface ProjectState {
  meta: ProjectMeta
  files: { path: string; bytes: number }[]
  report: Report | null
  versions: VersionInfo[]
  activity: ActivityEntry[]
  fab: { name: string; bytes: number }[]
  fabVerification: GerberVerification | null
  agentRunning: boolean
  has3d: boolean
}
export interface BuildProgress {
  stage: "compile" | "analyze" | "render" | "done"
  progress: number
  message: string
}
export interface Settings {
  configured: boolean
  source: string | null
  model: string
  effort: string
  baseURL: string | null
  /** Engine that will run the chat right now */
  provider: "anthropic" | "claude-code" | "codex" | "none"
  providerSetting: "auto" | "anthropic" | "claude-code" | "codex"
  providers: { anthropic: { available: boolean }; claudeCode: { available: boolean }; codex: { available: boolean; loggedIn: boolean } }
  mcpCommand: string
  root: string
}
export interface TemplateInfo {
  id: string
  name: string
  description: string
  tags: string[]
}
export interface PartHit {
  lcsc: string
  mpn: string
  package: string
  description: string
  stock: number | null
  price: number | null
  basic: boolean
  preferred: boolean
}

export type TranscriptPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool"
      id: string
      name: string
      input: any
      ok?: boolean
      summary?: string
      result?: any
      durationMs?: number
      /** live-only fields */
      inputBytes?: number
      progress?: BuildProgress
    }
  | { type: "error"; text: string }
export interface TranscriptItem {
  id: string
  role: "user" | "assistant"
  parts: TranscriptPart[]
  at: string
}

export type AgentEvent =
  | { type: "start"; messageId: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_input"; id: string; name: string; input: any }
  | { type: "tool_input_delta"; id: string; bytes: number }
  | { type: "tool_progress"; id: string; progress: BuildProgress }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string; result: any; durationMs: number }
  | { type: "error"; message: string; code?: string }
  | { type: "done"; stopReason: string; usage: { input: number; output: number; cacheRead: number } }

export class ApiError extends Error {
  code: string
  hint?: string
  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...(init.headers ?? {}) } : init?.headers,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.error) {
    const e = data?.error ?? { code: `http_${res.status}`, message: res.statusText }
    throw new ApiError(e.code, e.message, e.hint)
  }
  return data as T
}

const post = <T,>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) })

export const api = {
  projects: () => request<{ projects: ProjectMeta[] }>("/api/projects").then((r) => r.projects),
  createProject: (name: string, description?: string, code?: string) => post<ProjectState>("/api/projects", { name, description, code }),
  templates: () => request<{ templates: TemplateInfo[] }>("/api/templates").then((r) => r.templates),
  createFromTemplate: (template: string) => post<ProjectState>("/api/projects", { template }),
  project: (id: string) => request<ProjectState>(`/api/projects/${id}`),
  deleteProject: (id: string) => request(`/api/projects/${id}`, { method: "DELETE" }),
  renameProject: (id: string, name: string) => request(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  readFile: (id: string, path: string) =>
    request<{ path: string; content: string }>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`),
  writeFile: (id: string, path: string, content: string) =>
    request(`/api/projects/${id}/file`, { method: "PUT", body: JSON.stringify({ path, content }) }),
  build: (id: string, message?: string) => post<any>(`/api/projects/${id}/build`, { message }),
  exportFab: (id: string, force = false) => post<any>(`/api/projects/${id}/export`, { force }),
  exportReport: (id: string) => post<{ file: string; bytes: number }>(`/api/projects/${id}/report`),
  export3d: (id: string) => post<{ file: string; bytes: number }>(`/api/projects/${id}/export3d`),
  restore: (id: string, version: number) => post(`/api/projects/${id}/restore`, { version }),
  place: (id: string, body: { name: string; x?: number; y?: number; rotation?: number; layer?: "top" | "bottom" }) =>
    post<any>(`/api/projects/${id}/place`, body),
  importPart: (id: string, lcsc: string) => post<any>(`/api/projects/${id}/import-part`, { lcsc }),
  searchParts: (q: string) => request<{ parts: PartHit[]; count: number; note?: string }>(`/api/parts/search?q=${encodeURIComponent(q)}&limit=12`),
  chat: (id: string) => request<{ transcript: TranscriptItem[]; running: boolean }>(`/api/projects/${id}/chat`),
  sendChat: (id: string, message: string) => post(`/api/projects/${id}/chat`, { message }),
  stopChat: (id: string) => post(`/api/projects/${id}/chat/stop`),
  clearChat: (id: string) => request(`/api/projects/${id}/chat`, { method: "DELETE" }),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (patch: Partial<{ apiKey: string; baseURL: string; model: string; effort: string; provider: string }>) => post<Settings>("/api/settings", patch),
  artifactUrl: (id: string, file: string, bust?: string | number) =>
    `/api/projects/${id}/artifact/${file}${bust !== undefined ? `?v=${bust}` : ""}`,
}

/** Subscribe to a server-sent event stream; handlers are kept fresh without resubscribing. */
export function useEvents(path: string | null, handlers: Record<string, (data: any) => void>) {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    if (!path) return
    const es = new EventSource(path)
    const names = ["hello", "progress", "build", "files", "activity", "export", "agent", "projects"]
    for (const name of names)
      es.addEventListener(name, (ev) => {
        try {
          ref.current[name]?.(JSON.parse((ev as MessageEvent).data))
        } catch {}
      })
    return () => es.close()
  }, [path])
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "刚刚"
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
