#!/usr/bin/env bun
/**
 * AgentEDA web server: REST API + server-sent events + the built web UI.
 *
 *   bun run src/server.ts            (PORT=4477 by default)
 *
 * The server never holds project state in memory: it reads the same project folders the
 * CLI and MCP server write, and watches them, so work done by any agent shows up live.
 */
import path from "node:path"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { callTool, tools } from "./tools"
import { zodToJsonSchema } from "./schema"
import { GUIDE } from "./guide"
import {
  PROJECTS_DIR,
  ROOT,
  ENTRY,
  buildDir,
  listFiles,
  listProjects,
  listVersions,
  readMeta,
  requireProject,
  touchProject,
  EdaError,
} from "./engine/project"
import { readReport } from "./engine/build"
import { readActivity } from "./engine/activity"
import { renderPng } from "./engine/render"
import { clearChat, credentialStatus, isAgentRunning, loadChat, runAgent, saveSettings, stopAgent, type AgentEvent } from "./agent"

const PORT = Number(process.env.PORT ?? 4477)
const WEB_DIST = path.join(ROOT, "web", "dist")

// ---- SSE hub ---------------------------------------------------------------

type Send = (event: string, data: unknown) => void
const subscribers = new Map<string, Set<Send>>()

function publish(project: string, event: string, data: unknown) {
  for (const send of subscribers.get(project) ?? []) send(event, data)
  for (const send of subscribers.get("*") ?? []) send(event, { project, ...(data as object) })
}

function sse(project: string, req: Request): Response {
  let send: Send
  let heartbeat: Timer
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      send = (event, data) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {}
      }
      if (!subscribers.has(project)) subscribers.set(project, new Set())
      subscribers.get(project)!.add(send)
      send("hello", { project, agentRunning: project !== "*" && isAgentRunning(project) })
      heartbeat = setInterval(() => send("ping", {}), 20_000)
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat)
        subscribers.get(project)?.delete(send)
        try {
          controller.close()
        } catch {}
      })
    },
    cancel() {
      clearInterval(heartbeat)
      subscribers.get(project)?.delete(send)
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  })
}

// ---- file watching: relay changes made by other processes -------------------

fs.mkdirSync(PROJECTS_DIR, { recursive: true })
const debounce = new Map<string, Timer>()
function relay(project: string, kind: string, payload: object = {}) {
  const key = `${project}:${kind}`
  clearTimeout(debounce.get(key))
  debounce.set(
    key,
    setTimeout(() => {
      debounce.delete(key)
      publish(project, kind, payload)
    }, kind === "progress" ? 30 : 120),
  )
}
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, async (_event, filename) => {
    if (!filename) return
    const parts = filename.split(path.sep)
    const project = parts[0]!
    const rest = parts.slice(1).join("/")
    if (!rest) return relay("*", "projects")
    if (rest === "aeda.json") return relay("*", "projects")
    if (rest === ".aeda/progress.json") {
      try {
        const p = JSON.parse(await fsp.readFile(path.join(PROJECTS_DIR, project, ".aeda", "progress.json"), "utf8"))
        publish(project, "progress", p)
      } catch {}
      return
    }
    if (rest === ".aeda/report.json") {
      relay(project, "build")
      relay("*", "projects")
      return
    }
    if (rest === ".aeda/activity.jsonl") return relay(project, "activity")
    if (rest.startsWith(".aeda/fab/")) return relay(project, "export")
    if (rest.startsWith(".aeda/")) return
    relay(project, "files", { path: rest })
  })
} catch (e) {
  console.error("file watching unavailable:", e)
}

// ---- helpers ---------------------------------------------------------------

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } })

const fail = (e: any) => {
  if (e instanceof EdaError) {
    const status = /not_found/.test(e.code) ? 404 : 400
    return json({ error: { code: e.code, message: e.message, hint: e.hint } }, status)
  }
  console.error(e)
  return json({ error: { code: "internal_error", message: String(e?.message ?? e) } }, 500)
}

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".zip": "application/zip",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".kicad_pcb": "text/plain; charset=utf-8",
  ".kicad_sch": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
}

async function projectState(id: string) {
  const [meta, files, report, versions, activity] = await Promise.all([
    readMeta(id),
    listFiles(id),
    readReport(id),
    listVersions(id),
    readActivity(id, 60),
  ])
  const fabDir = path.join(buildDir(id), "fab")
  let fab: { name: string; bytes: number }[] = []
  if (fs.existsSync(fabDir))
    fab = (await fsp.readdir(fabDir)).map((name) => ({ name, bytes: fs.statSync(path.join(fabDir, name)).size }))
  let fabVerification: unknown = null
  const vf = path.join(buildDir(id), "fab-verification.json")
  if (fs.existsSync(vf)) {
    try {
      fabVerification = JSON.parse(await fsp.readFile(vf, "utf8"))
    } catch {}
  }
  return { meta, files, report, versions, activity, fab, fabVerification, agentRunning: isAgentRunning(id), has3d: fs.existsSync(path.join(buildDir(id), "board.glb")) }
}

// ---- routes ----------------------------------------------------------------

/**
 * The API has no login, so it must only ever answer this machine's own tools and its own page.
 *  - The Host header must be a loopback name: stops DNS rebinding.
 *  - A browser request from any other origin is refused: stops a web page the user happens to
 *    visit from creating a project, writing code into it and having it built (which runs it).
 *  - A request with a body must be JSON: a cross-site form or no-cors fetch cannot send that.
 * Requests without an Origin header (the CLI, MCP clients, curl, tests) are local tools.
 */
function guard(req: Request, url: URL): Response | null {
  if (!url.pathname.startsWith("/api/")) return null
  const loopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
  const hostHeader = req.headers.get("host") ?? ""
  const host = hostHeader.replace(/:\d+$/, "")
  // Binding to a non-loopback address (HOST=...) is an explicit choice to serve other machines;
  // the Host check cannot apply then, the Origin check below still does.
  const servesNetwork = Boolean(process.env.HOST) && !loopback(process.env.HOST!)
  if (!servesNetwork && host && !loopback(host))
    return json({ error: { code: "forbidden_host", message: "This API only answers on its local address." } }, 403)
  const origin = req.headers.get("origin")
  if (origin) {
    let own = false
    try {
      const o = new URL(origin)
      // Same origin as the address this request was sent to (whatever the port), or the Vite dev server.
      own = o.host === hostHeader || (loopback(o.hostname) && o.port === "5173")
    } catch {}
    if (!own) return json({ error: { code: "forbidden_origin", message: "Requests from other origins are not allowed." } }, 403)
  } else if (req.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: { code: "forbidden_origin", message: "Requests from other sites are not allowed." } }, 403)
  }
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    const type = (req.headers.get("content-type") ?? "").toLowerCase()
    if (!type.startsWith("application/json"))
      return json({ error: { code: "unsupported_media_type", message: "Send JSON with content-type: application/json." } }, 415)
  }
  return null
}

/** decodeURIComponent that answers a malformed URL with 400 instead of a crash. */
const decodeSeg = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    throw new EdaError("bad_request", "Malformed URL encoding")
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const refused = guard(req, url)
  if (refused) return refused
  const p = url.pathname
  const method = req.method
  const body = async () => (await req.json().catch(() => ({}))) as any

  if (p === "/api/health") return json({ ok: true, name: "agenteda", version: "0.1.0" })
  if (p === "/api/guide") return json({ guide: GUIDE })
  if (p === "/api/tools" && method === "GET")
    return json({ tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, readOnly: Boolean(t.readOnly), input_schema: zodToJsonSchema(t.shape) })) })

  // Generic tool endpoint: the whole agent surface over HTTP.
  let m = p.match(/^\/api\/tools\/([a-z0-9_]+)$/)
  if (m && method === "POST") {
    const args = await body()
    const { ok, result } = await callTool(m[1]!, args, { source: "http" })
    return json(result, ok ? 200 : 400)
  }

  if (p === "/api/settings" && method === "GET") return json({ ...(await credentialStatus()), mcpCommand: `bun run ${path.join(ROOT, "src", "mcp.ts")}`, root: ROOT })
  if (p === "/api/settings" && method === "POST") {
    const b = await body()
    const patch: any = {}
    if (typeof b.apiKey === "string") patch.apiKey = b.apiKey.trim()
    if (typeof b.baseURL === "string") patch.baseURL = b.baseURL.trim()
    if (typeof b.model === "string" && b.model.trim()) patch.model = b.model.trim()
    if (["low", "medium", "high", "xhigh", "max"].includes(b.effort)) patch.effort = b.effort
    if (["auto", "anthropic", "claude-code", "codex"].includes(b.provider)) patch.provider = b.provider
    await saveSettings(patch)
    return json(await credentialStatus())
  }

  if (p === "/api/events") return sse("*", req)
  if (p === "/api/projects" && method === "GET") return json({ projects: await listProjects() })
  if (p === "/api/templates") {
    const { result } = await callTool("list_templates", {})
    return json(result)
  }
  if (p.startsWith("/api/templates/") && p.endsWith("/preview.svg")) {
    // Pre-rendered thumbnail shipped with the template, if any.
    const id = p.split("/")[3]!
    const file = path.join(ROOT, "templates", id, "preview.svg")
    if (/^[a-z0-9-]+$/.test(id) && fs.existsSync(file)) return new Response(Bun.file(file), { headers: { "content-type": "image/svg+xml" } })
    return json({ error: { code: "not_found", message: "No preview" } }, 404)
  }
  if (p === "/api/projects" && method === "POST") {
    const b = await body()
    const { ok, result } = await callTool("create_project", { name: b.name, description: b.description, code: b.code, template: b.template }, { source: "web" })
    if (!ok) return json(result, 400)
    return json(await projectState((result as any).project))
  }
  if (p === "/api/parts/search") {
    const { ok, result } = await callTool("search_parts", {
      query: url.searchParams.get("q") ?? "",
      package: url.searchParams.get("package") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 12),
    })
    return json(result, ok ? 200 : 400)
  }

  m = p.match(/^\/api\/projects\/([^/]+)(\/.*)?$/)
  if (m) {
    const id = decodeSeg(m[1]!)
    const sub = m[2] ?? ""
    try {
      if (sub === "" && method === "GET") return json(await projectState(id))
      if (sub === "" && method === "DELETE") {
        const { ok, result } = await callTool("delete_project", { project: id }, { source: "web" })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "" && method === "PATCH") {
        const b = await body()
        requireProject(id)
        return json(await touchProject(id, { ...(typeof b.name === "string" ? { name: b.name } : {}), ...(typeof b.description === "string" ? { description: b.description } : {}) }))
      }
      if (sub === "/events") {
        requireProject(id)
        return sse(id, req)
      }
      if (sub === "/file" && method === "GET") {
        const { ok, result } = await callTool("read_file", { project: id, path: url.searchParams.get("path") ?? ENTRY })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/file" && method === "PUT") {
        const b = await body()
        const { ok, result } = await callTool("write_file", { project: id, path: b.path ?? ENTRY, content: b.content }, { source: "web" })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/build" && method === "POST") {
        const b = await body()
        const { ok, result } = await callTool(
          "build",
          { project: id, detail: true, no_parts: b.noParts, message: b.message },
          { source: "web" }, // progress reaches the UI through the watched progress.json
        )
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/export" && method === "POST") {
        const b = await body()
        const { ok, result } = await callTool("export_fab", { project: id, force: b.force }, { source: "web" })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/report" && method === "POST") {
        const { ok, result } = await callTool("export_report", { project: id }, { source: "web" })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/export3d" && method === "POST") {
        const { ok, result } = await callTool("export_3d", { project: id }, { source: "web" })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/restore" && method === "POST") {
        const b = await body()
        const { ok, result } = await callTool("restore_version", { project: id, version: Number(b.version) }, { source: "web" })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/place" && method === "POST") {
        const b = await body()
        const { ok, result } = await callTool("place_component", { project: id, name: b.name, x: b.x, y: b.y, rotation: b.rotation, layer: b.layer }, { source: "web" })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/import-part" && method === "POST") {
        const b = await body()
        const { ok, result } = await callTool("import_part", { project: id, lcsc: String(b.lcsc ?? "") }, { source: "web" })
        return json(result, ok ? 200 : 400)
      }
      if (sub === "/report") return json((await readReport(id)) ?? null)
      if (sub === "/render.png") {
        const view = (url.searchParams.get("view") ?? "pcb") as any
        const png = await renderPng(id, view, Number(url.searchParams.get("width") ?? 1200))
        return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store" } })
      }
      if (sub === "/chat" && method === "GET") {
        const chat = await loadChat(id)
        return json({ transcript: chat.transcript, running: isAgentRunning(id) })
      }
      if (sub === "/chat" && method === "DELETE") {
        await clearChat(id)
        return json({ cleared: true })
      }
      if (sub === "/chat/stop" && method === "POST") {
        stopAgent(id)
        return json({ stopping: true })
      }
      if (sub === "/chat" && method === "POST") {
        const b = await body()
        const text = String(b.message ?? "").trim()
        if (!text) return json({ error: { code: "empty_message", message: "Message is empty" } }, 400)
        requireProject(id)
        if (isAgentRunning(id)) return json({ error: { code: "busy", message: "The agent is already working on this project." } }, 409)
        // Fire and forget: progress reaches every open tab through the project's event stream.
        const emit = (e: AgentEvent) => publish(id, "agent", e)
        runAgent(id, text, emit).catch((e) => emit({ type: "error", message: String(e?.message ?? e) }))
        return json({ started: true })
      }
      // Build artifacts and downloads: /api/projects/:id/artifact/<file under .aeda>
      if (sub.startsWith("/artifact/")) {
        requireProject(id)
        const rel = decodeSeg(sub.slice("/artifact/".length))
        const base = buildDir(id)
        const full = path.resolve(base, rel)
        if (!full.startsWith(base + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory())
          return json({ error: { code: "artifact_not_found", message: `No artifact "${rel}"`, hint: "Build (or export) first." } }, 404)
        const ext = path.extname(full)
        const headers: Record<string, string> = { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" }
        // Generated HTML is served without script or network rights.
        if (ext === ".html") headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        if (url.searchParams.has("download") || [".zip", ".csv", ".kicad_pcb", ".kicad_sch", ".glb"].includes(ext))
          headers["content-disposition"] = `attachment; filename="${path.basename(full)}"`
        return new Response(Bun.file(full), { headers })
      }
      return json({ error: { code: "not_found", message: `No route ${method} ${p}` } }, 404)
    } catch (e) {
      return fail(e)
    }
  }

  if (p.startsWith("/api/")) return json({ error: { code: "not_found", message: `No route ${method} ${p}` } }, 404)

  // Static web UI (single-page app)
  const rel = p === "/" ? "index.html" : p.slice(1)
  const file = path.resolve(WEB_DIST, rel)
  if (file.startsWith(WEB_DIST) && fs.existsSync(file) && fs.statSync(file).isFile())
    return new Response(Bun.file(file), {
      headers: {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        // Hashed assets are immutable; everything else (index.html) must be revalidated.
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    })
  const index = path.join(WEB_DIST, "index.html")
  if (fs.existsSync(index)) return new Response(Bun.file(index), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } })
  return new Response("AgentEDA API is running. The web UI has not been built yet: run `bun run build:web`.", { status: 200 })
}

const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    try {
      return await handle(req)
    } catch (e) {
      return fail(e)
    }
  },
})

console.log(`AgentEDA running at http://${server.hostname}:${server.port}`)
