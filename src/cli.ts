#!/usr/bin/env bun
/**
 * aeda - AgentEDA command line. Every tool in src/tools.ts is a subcommand.
 *
 *   aeda <tool> [--key value ...] [--json '{"...": ...}']
 *   aeda build my-board --detail
 *   aeda write_file my-board --content @design.tsx
 *
 * Output is always one JSON document on stdout. Exit code 0 = ok, 1 = tool error.
 * `--pretty` switches to a short human summary for build/export.
 */
import fs from "node:fs"
import { z } from "zod"
import { callTool, tools, toolByName } from "./tools"
import { GUIDE } from "./guide"

const argv = process.argv.slice(2)

function typeName(schema: z.ZodTypeAny): string {
  let s: any = schema
  while (s?._def?.innerType) s = s._def.innerType
  const t = s?._def?.typeName
  if (t === "ZodNumber") return "number"
  if (t === "ZodBoolean") return "boolean"
  return "string"
}
const isOptional = (schema: z.ZodTypeAny) => schema.isOptional()

function help() {
  const lines = [
    "aeda - agent-native PCB design (AgentEDA)",
    "",
    "Usage: aeda <command> [project] [--arg value ...] [--pretty]",
    "",
    "Commands:",
  ]
  for (const t of tools) {
    const args = Object.entries(t.shape as Record<string, z.ZodTypeAny>)
      .map(([k, s]) => (isOptional(s) ? `[--${k}]` : `--${k}`))
      .join(" ")
    lines.push(`  ${t.name.padEnd(16)} ${t.description.split(". ")[0]}.`)
    if (args) lines.push(`  ${" ".repeat(16)} ${args}`)
  }
  lines.push(
    "",
    "Other:",
    "  guide            Print the design guide (markdown)",
    "  serve            Start the web app + HTTP API   [--port 4477]",
    "  mcp              Start the MCP server on stdio",
    "  tools            Print the tool schemas as JSON",
    "",
    "Notes:",
    "  - The first positional argument is taken as --project.",
    "  - A value starting with @ is read from that file (--content @board.tsx). '-' reads stdin.",
    "  - Output is JSON. Exit code is 1 when the tool returns an error.",
  )
  console.log(lines.join("\n"))
}

function readValue(v: string): string {
  if (v === "-") return fs.readFileSync(0, "utf8")
  if (v.startsWith("@")) return fs.readFileSync(v.slice(1), "utf8")
  return v
}

async function main() {
  const cmd = argv[0]
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return help()
  if (cmd === "guide") return console.log(GUIDE)
  if (cmd === "serve") {
    const i = argv.indexOf("--port")
    if (i > 0) process.env.PORT = argv[i + 1]
    await import("./server")
    return
  }
  if (cmd === "mcp") {
    await import("./mcp")
    return
  }
  if (cmd === "tools") {
    const { zodToJsonSchema } = await import("./schema")
    return console.log(
      JSON.stringify(
        tools.map((t) => ({ name: t.name, description: t.description, input_schema: zodToJsonSchema(t.shape) })),
        null,
        2,
      ),
    )
  }

  const name = cmd.replace(/-/g, "_")
  const tool = toolByName.get(name)
  if (!tool) {
    console.log(JSON.stringify({ error: { code: "unknown_command", message: `Unknown command "${cmd}"`, hint: "Run `aeda help`." } }))
    process.exit(1)
  }
  const shape = tool.shape as Record<string, z.ZodTypeAny>
  let args: Record<string, unknown> = {}
  let pretty = false
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === "--pretty") {
      pretty = true
    } else if (a === "--json") {
      args = { ...args, ...JSON.parse(readValue(rest[++i] ?? "{}")) }
    } else if (a.startsWith("--")) {
      const [rawKey, inline] = a.slice(2).split(/=(.*)/s)
      const key = rawKey!.replace(/-/g, "_")
      const schema = shape[key]
      const kind = schema ? typeName(schema) : "string"
      if (kind === "boolean" && inline === undefined && (rest[i + 1] === undefined || rest[i + 1]!.startsWith("--"))) {
        args[key] = true
      } else {
        const value = readValue(inline ?? rest[++i] ?? "")
        args[key] = kind === "number" ? Number(value) : kind === "boolean" ? value !== "false" : value
      }
    } else if ("project" in shape && args.project === undefined) {
      args.project = a
    } else if ("query" in shape && args.query === undefined) {
      args.query = a
    } else if ("name" in shape && args.name === undefined) {
      args.name = a
    } else if ("lcsc" in shape && args.lcsc === undefined) {
      args.lcsc = a
    } else if ("path" in shape && args.path === undefined) {
      args.path = a
    }
  }

  const isTty = process.stderr.isTTY
  const { ok, result } = await callTool(name, args, {
    onProgress: (p) => {
      if (isTty) process.stderr.write(`\r\x1b[K[${String(Math.round(p.progress * 100)).padStart(3)}%] ${p.message}`)
    },
  })
  if (isTty) process.stderr.write("\r\x1b[K")

  if (pretty && ok && name === "build") {
    const r: any = result
    const s = r.summary
    console.log(
      [
        `${r.ok ? "PASS" : "FAIL"}  ${r.project} v${r.version}  (${(r.durationMs / 1000).toFixed(1)}s)`,
        s.board ? `board ${s.board.widthMm} x ${s.board.heightMm} mm, ${s.board.layers} layers` : "no board",
        `${s.components} components, ${s.nets} nets, ${s.traces} traces, ${s.vias} vias, routed ${s.connectionsRouted}/${s.connectionsTotal}`,
        `BOM ${s.bomSourced}/${s.bomLines} sourced`,
        ...r.errors.map((e: any) => `  error   ${e.code}: ${e.message}`),
        ...r.warnings.map((e: any) => `  warning ${e.code}: ${e.message}`),
      ].join("\n"),
    )
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.log(JSON.stringify({ error: { code: "cli_crash", message: String(e?.message ?? e) } }))
  process.exit(1)
})
