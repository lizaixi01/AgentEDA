/**
 * The same tool table must be reachable, and behave the same, over MCP (stdio) and HTTP.
 * Boards here build with no_parts so the tests do not depend on the parts catalogue.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const ROOT = path.resolve(import.meta.dir, "..")
const projectsDir = path.join(ROOT, "projects", `.test-if-${Date.now()}`)
const env = { ...process.env, AEDA_PROJECTS_DIR: projectsDir } as Record<string, string>

const BOARD = `export default () => (
  <board width="20mm" height="15mm">
    <resistor name="R1" resistance="1k" footprint="0402" />
    <resistor name="R2" resistance="2k" footprint="0402" />
    <trace from="R1.pin1" to="R2.pin1" />
    <trace from="R1.pin2" to="R2.pin2" />
  </board>
)
`

afterAll(() => fs.rmSync(projectsDir, { recursive: true, force: true }))

describe("MCP server", () => {
  let client: Client
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    const first = r.content[0]
    return { isError: Boolean(r.isError), first, json: first.type === "text" ? JSON.parse(first.text) : null }
  }

  beforeAll(async () => {
    client = new Client({ name: "test", version: "0" })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["run", path.join(ROOT, "src", "mcp.ts")], env }))
  })
  afterAll(() => client.close())

  test("lists every tool with a description and schema, plus guide resource and prompt", async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    for (const n of ["get_guide", "create_project", "write_file", "edit_file", "place_component", "build", "get_report", "render", "search_parts", "browse_parts", "import_part", "export_fab"])
      expect(names).toContain(n)
    expect(new Set(names).size).toBe(names.length)
    for (const t of tools) {
      expect((t.description ?? "").length).toBeGreaterThan(20)
      expect(t.inputSchema.type).toBe("object")
    }
    expect(client.getInstructions()).toContain("build")
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain("agenteda://guide")
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("design_board")
  })

  test("runs the design loop and returns an image from render", async () => {
    const created = await call("create_project", { name: "mcp loop", code: BOARD })
    expect(created.isError).toBe(false)
    const project = created.json.project
    const built = await call("build", { project, no_parts: true })
    expect(built.json.summary.connectionsRouted).toBe(2)
    expect(built.json.errors).toEqual([])
    const image = await call("render", { project, view: "pcb", width: 400 })
    expect(image.first.type).toBe("image")
    expect(image.first.mimeType).toBe("image/png")
    expect(image.first.data.length).toBeGreaterThan(500)
  }, 180_000)

  test("tool errors come back as isError with code, message and hint", async () => {
    const r = await call("build", { project: "no-such-project" })
    expect(r.isError).toBe(true)
    expect(r.json.error.code).toBe("project_not_found")
    expect(r.json.error.hint).toBeTruthy()
  })
})

describe("HTTP API", () => {
  const port = 4700 + Math.floor(Math.random() * 200)
  const base = `http://127.0.0.1:${port}`
  let server: ReturnType<typeof Bun.spawn>

  beforeAll(async () => {
    server = Bun.spawn([process.execPath, "run", path.join(ROOT, "src", "server.ts")], { env: { ...env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" })
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return
      } catch {}
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error("server did not start")
  })
  afterAll(() => server.kill())

  const post = async (p: string, body: unknown) => {
    const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    return { status: res.status, json: (await res.json()) as any }
  }

  test("exposes the tool table and runs tools by name", async () => {
    const tools = ((await (await fetch(`${base}/api/tools`)).json()) as any).tools
    expect(tools.length).toBeGreaterThanOrEqual(19)
    const created = await post("/api/tools/create_project", { name: "http loop", code: BOARD })
    expect(created.status).toBe(200)
    const project = created.json.project
    const built = await post("/api/tools/build", { project, no_parts: true })
    expect(built.json.ok).toBe(true)
    const state = (await (await fetch(`${base}/api/projects/${project}`)).json()) as any
    expect(state.report.summary.components).toBe(2)
    expect(state.activity.some((a: any) => a.tool === "build" && a.source === "http")).toBe(true)
    const svg = await fetch(`${base}/api/projects/${project}/artifact/pcb.svg`)
    expect(svg.headers.get("content-type")).toContain("image/svg+xml")
    const png = await fetch(`${base}/api/projects/${project}/render.png?view=pcb&width=300`)
    expect(png.headers.get("content-type")).toBe("image/png")
  }, 180_000)

  test("errors are structured and artifact paths cannot escape", async () => {
    const bad = await post("/api/tools/build", { project: "no-such-project" })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe("project_not_found")
    const unknown = await post("/api/tools/does_not_exist", {})
    expect(unknown.json.error.code).toBe("unknown_tool")
    const created = await post("/api/tools/create_project", { name: "escape", code: BOARD })
    const escape = await fetch(`${base}/api/projects/${created.json.project}/artifact/..%2F..%2F..%2Fpackage.json`)
    expect(escape.status).toBe(404)
  })

  test("settings never return the API key", async () => {
    const s = (await (await fetch(`${base}/api/settings`)).json()) as any
    expect(Object.keys(s)).not.toContain("apiKey")
    expect(typeof s.configured).toBe("boolean")
  })
})

describe("HTTP API is closed to other web pages", () => {
  const port = 4900 + Math.floor(Math.random() * 90)
  const base = `http://127.0.0.1:${port}`
  let server: ReturnType<typeof Bun.spawn>
  beforeAll(async () => {
    server = Bun.spawn([process.execPath, "run", path.join(ROOT, "src", "server.ts")], { env: { ...env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" })
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return
      } catch {}
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error("server did not start")
  })
  afterAll(() => server.kill())

  const create = (headers: Record<string, string>, body = JSON.stringify({ name: "from elsewhere", code: BOARD })) =>
    fetch(`${base}/api/tools/create_project`, { method: "POST", headers, body })

  test("a request carrying another site's Origin is refused, even with a JSON body", async () => {
    const r = await create({ "content-type": "application/json", origin: "https://evil.example" })
    expect(r.status).toBe(403)
    expect(((await r.json()) as any).error.code).toBe("forbidden_origin")
  })

  test("a form-style body (what a no-cors fetch can send) is refused", async () => {
    const r = await create({ "content-type": "text/plain" })
    expect(r.status).toBe(415)
  })

  test("the app's own origin and tools without an Origin are accepted", async () => {
    expect((await create({ "content-type": "application/json", origin: `http://127.0.0.1:${port}` })).status).toBe(200)
    // another local page on a different port is not this app
    expect((await create({ "content-type": "application/json", origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403)
    expect((await create({ "content-type": "application/json" })).status).toBe(200)
  })

  test("a malformed URL is a 400, and an unknown render view cannot reach other files", async () => {
    expect((await fetch(`${base}/api/projects/%E0%A4%A`)).status).toBe(400)
    const made = (await (await create({ "content-type": "application/json" })).json()) as any
    const r = await fetch(`${base}/api/projects/${made.project}/render.png?view=${encodeURIComponent("../../../x")}`)
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error.code).toBe("bad_view")
  })
})
