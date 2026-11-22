#!/usr/bin/env bun
/**
 * AgentEDA MCP server (stdio). Exposes every tool in src/tools.ts.
 *
 *   claude mcp add agenteda -- bun run /abs/path/to/AgentEDA/src/mcp.ts
 *
 * stdout carries the protocol, so nothing here may console.log.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { callTool, tools, PROJECT_AGENT_TOOLS } from "./tools"
import { GUIDE } from "./guide"
import { renderPng } from "./engine/render"

const server = new McpServer(
  { name: "agenteda", version: "0.1.0" },
  {
    instructions:
      "AgentEDA designs real PCBs from code. Workflow: get_guide (once) -> create_project -> write_file -> build -> fix errors -> build ... -> export_fab. " +
      "build is the verification loop: never report a board as done until build returns ok: true. " +
      "Use search_parts + import_part for every IC and connector instead of guessing footprints. " +
      "Use render to look at the schematic or PCB when layout matters.",
  },
)

/**
 * Pinned mode: AEDA_PIN_PROJECT=<id> binds this server to one project. Only project-scoped
 * tools are offered and the project argument is supplied here, so every tool the connected agent
 * is given acts on that project. This scopes the tool surface; it is not a sandbox: build runs the
 * design code the agent writes (see the security notes in the README). Used when AgentEDA drives
 * a local agent CLI itself.
 */
const PIN = process.env.AEDA_PIN_PROJECT || null
const SOURCE = (process.env.AEDA_SOURCE as "mcp" | "agent" | undefined) ?? "mcp"
const offered = PIN ? tools.filter((t) => t.name === "get_guide" || (PROJECT_AGENT_TOOLS as readonly string[]).includes(t.name)) : tools

for (const tool of offered) {
  if (tool.name === "render") continue // registered below with an image result
  const shape = PIN ? Object.fromEntries(Object.entries(tool.shape).filter(([k]) => k !== "project")) : tool.shape
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: shape,
      annotations: { readOnlyHint: Boolean(tool.readOnly), openWorldHint: /parts|import/.test(tool.name) },
    },
    async (args: any, extra: any) => {
      const progressToken = extra?._meta?.progressToken
      const { ok, result } = await callTool(tool.name, PIN ? { ...args, project: PIN } : args, {
        source: SOURCE,
        onProgress: (p) => {
          if (progressToken === undefined) return
          extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: Math.round(p.progress * 100), total: 100, message: p.message },
            })
            .catch(() => {})
        },
      })
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: !ok }
    },
  )
}

// Vision: let the agent actually look at what it built.
import { z } from "zod"
server.registerTool(
  "render",
  {
    title: "Render view",
    description:
      "Return a PNG image of the last build so you can inspect it visually: 'pcb' (copper, pads, silkscreen), 'schematic', 'assembly', or 'simulation' (SPICE waveforms, when the design has probes). Use after build to judge placement and routing quality.",
    inputSchema: {
      ...(PIN ? {} : { project: z.string().describe("Project id") }),
      view: z.enum(["pcb", "schematic", "assembly", "simulation"]).optional().describe("Default: pcb"),
      width: z.number().int().min(300).max(2000).optional().describe("Image width in px, default 1000"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: any) => {
    try {
      const png = await renderPng(PIN ?? args.project, args.view ?? "pcb", args.width ?? 1000)
      return { content: [{ type: "image" as const, data: Buffer.from(png).toString("base64"), mimeType: "image/png" }] }
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: { code: e.code ?? "render_failed", message: e.message, hint: e.hint } }) }],
        isError: true,
      }
    }
  },
)

server.registerResource(
  "guide",
  "agenteda://guide",
  { title: "AgentEDA design guide", description: "Syntax, workflow and examples for designing boards", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, text: GUIDE, mimeType: "text/markdown" }] }),
)

server.registerPrompt(
  "design_board",
  {
    title: "Design a PCB",
    description: "Design a board from a product description, verify it, and export manufacturing files",
    argsSchema: { requirement: z.string().describe("What the board should do") },
  },
  ({ requirement }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Design a PCB with AgentEDA for this requirement:\n\n${requirement}\n\nRead get_guide first. Create a project, write the design, and iterate with build until ok is true. Then export_fab and summarise the board, the assumptions you made, and anything the automated checks cannot verify.`,
        },
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
