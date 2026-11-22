/**
 * Chat-agent providers that drive a local agent CLI instead of calling the Anthropic API with
 * a key: Claude Code (the user's Claude subscription login) and Codex (their ChatGPT login).
 *
 * The CLI is given exactly one capability: this repo's MCP server in pinned mode, bound to the
 * current project. Its event stream is translated into the same AgentEvent stream the web UI
 * already understands, so the chat panel does not care which provider is behind it.
 */
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import { ROOT, buildDir } from "./engine/project"
import { summarize } from "./tools"
import type { AgentEvent, TranscriptItem } from "./agent"

export type CliProvider = "claude-code" | "codex"

export class CliAgentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

// ---- finding the CLIs --------------------------------------------------------

export function findClaudeCli(configured?: string): string | null {
  if (configured && existsSync(configured)) return configured
  const onPath = Bun.which("claude")
  if (onPath) return onPath
  // The Claude desktop app ships its own copy of Claude Code; use the newest one.
  const base = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code")
  try {
    const versions = readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions)
      for (const build of readdirSync(path.join(base, v))) {
        const bin = path.join(base, v, build, "claude.app", "Contents", "MacOS", "claude")
        if (existsSync(bin)) return bin
      }
  } catch {}
  return null
}

export function findCodexCli(configured?: string): string | null {
  if (configured && existsSync(configured)) return configured
  const onPath = Bun.which("codex")
  if (onPath) return onPath
  // The ChatGPT desktop app bundles the Codex CLI.
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
  return existsSync(bundled) ? bundled : null
}

/** Codex keeps its login in $CODEX_HOME/auth.json; its presence is the signal, the content is never read. */
export function codexLoggedIn(): boolean {
  return existsSync(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json"))
}

// ---- shared plumbing -----------------------------------------------------------

export interface CliRun {
  provider: CliProvider
  bin: string
  projectId: string
  userText: string
  /** Role + design guide + which project this is */
  systemText: string
  /** Provider session to continue, from an earlier turn of this chat */
  sessionId: string | null
  reply: TranscriptItem
  emit: (e: AgentEvent) => void
  signal: AbortSignal
  /** Called after each tool result so the transcript on disk keeps up with a long turn */
  checkpoint?: () => unknown
  /** Called as soon as the CLI reports which session this turn belongs to */
  onSession?: (id: string) => void
}

export interface CliResult {
  sessionId: string | null
  stopReason: string
  usage: { input: number; output: number; cacheRead: number }
}

type ToolPart = Extract<TranscriptItem["parts"][number], { type: "tool" }>

const MCP_PREFIX = "mcp__agenteda__"

function mcpSpec(projectId: string) {
  return {
    command: process.execPath,
    args: ["run", path.join(ROOT, "src", "mcp.ts")],
    env: {
      AEDA_PIN_PROJECT: projectId,
      AEDA_SOURCE: "agent",
      ...(process.env.AEDA_PROJECTS_DIR ? { AEDA_PROJECTS_DIR: process.env.AEDA_PROJECTS_DIR } : {}),
    } as Record<string, string>,
  }
}

/** A scratch working directory outside the repo, so the CLI does not pick up this repo's own agent instructions. */
async function agentCwd(provider: CliProvider, projectId: string) {
  const dir = path.join(os.tmpdir(), "agenteda-agent", provider, projectId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream as any) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) yield line
    }
  }
  if (buffer.trim()) yield buffer.trim()
}

/** Text of an MCP tool result (our tools answer with one JSON text block; `render` answers with an image). */
function resultText(content: unknown): { text: string; image: boolean } {
  if (typeof content === "string") return { text: content, image: false }
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n")
    return { text, image: content.some((b: any) => b?.type === "image") }
  }
  return { text: "", image: false }
}

/** Bookkeeping for tool calls: transcript parts, UI events, and build progress relayed from disk. */
function toolTracker(run: CliRun) {
  const open = new Map<string, { name: string; input: any; started: number; part: ToolPart; poll?: Timer }>()
  const progressFile = path.join(buildDir(run.projectId), "progress.json")

  return {
    start(id: string, rawName: string) {
      if (open.has(id)) return
      const name = rawName.startsWith(MCP_PREFIX) ? rawName.slice(MCP_PREFIX.length) : rawName
      const part: ToolPart = { type: "tool", id, name, input: {} }
      run.reply.parts.push(part)
      const entry: { name: string; input: any; started: number; part: ToolPart; poll?: Timer } = { name, input: {}, started: Date.now(), part }
      open.set(id, entry)
      run.emit({ type: "tool_start", id, name })
      if (name === "build") {
        let last = 0
        entry.poll = setInterval(async () => {
          try {
            const p = JSON.parse(await fs.readFile(progressFile, "utf8"))
            if (p.at > entry.started && p.at !== last && p.stage !== "done") {
              last = p.at
              run.emit({ type: "tool_progress", id, progress: { stage: p.stage, progress: p.progress, message: p.message } })
            }
          } catch {}
        }, 400)
      }
    },
    input(id: string, input: any) {
      const entry = open.get(id)
      if (!entry) return
      entry.input = input ?? {}
      // File bodies are not kept in the chat transcript; the code tab has them.
      entry.part.input =
        entry.name === "write_file" ? { ...entry.input, content: undefined, bytes: String(entry.input?.content ?? "").length } : entry.input
      run.emit({ type: "tool_input", id, name: entry.name, input: entry.input })
    },
    end(id: string, isError: boolean, content: unknown, errorMessage?: string) {
      const entry = open.get(id)
      if (!entry) return
      clearInterval(entry.poll)
      open.delete(id)
      const { text, image } = resultText(content)
      let result: any = null
      try {
        result = text ? JSON.parse(text) : null
      } catch {
        result = text ? { text: text.slice(0, 2000) } : null
      }
      if (errorMessage && !result) result = { error: { code: "tool_call_failed", message: errorMessage } }
      const ok = !isError && !result?.error
      const summary =
        entry.name === "render"
          ? ok
            ? `Looked at the ${entry.input?.view ?? "pcb"}`
            : String(result?.error?.message ?? errorMessage ?? "render failed")
          : summarize(entry.name, { ...entry.input, project: run.projectId }, { ok, result: result ?? {} })
      const shown = image ? null : result && JSON.stringify(result).length > 6000 ? { truncated: true, preview: JSON.stringify(result).slice(0, 6000) } : result
      const durationMs = Date.now() - entry.started
      Object.assign(entry.part, { ok, summary, result: shown, durationMs })
      run.emit({ type: "tool_end", id, name: entry.name, ok, summary, result: shown, durationMs })
      run.checkpoint?.()
    },
    /** Anything still open when the CLI exits never produced a result. */
    closeAll() {
      for (const [id] of open) this.end(id, true, null, "The agent stopped before this tool returned.")
    },
  }
}

function appendPart(run: CliRun, kind: "text" | "thinking", delta: string) {
  if (!delta) return
  const last = run.reply.parts[run.reply.parts.length - 1]
  if (last && last.type === kind) last.text += delta
  else run.reply.parts.push({ type: kind, text: delta })
  run.emit({ type: kind, delta })
}

// ---- Claude Code (Claude subscription) --------------------------------------------

async function runClaudeCode(run: CliRun): Promise<CliResult> {
  const cwd = await agentCwd("claude-code", run.projectId)
  const args = [
    run.bin,
    "-p", // the prompt is read from stdin, so no user text is ever parsed as a flag
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: { agenteda: mcpSpec(run.projectId) } }),
    "--tools",
    "", // no built-in tools: no shell, no file access outside our MCP server
    "--allowedTools",
    "mcp__agenteda",
    "--system-prompt",
    run.systemText,
    ...(run.sessionId ? ["--resume", run.sessionId] : []),
  ]
  const proc = Bun.spawn(args, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } })
  const onAbort = () => proc.kill()
  run.signal.addEventListener("abort", onAbort)
  proc.stdin.write(run.userText)
  await proc.stdin.end()

  const tools = toolTracker(run)
  const blockTool = new Map<number, { id: string; bytes: number }>()
  let sessionId = run.sessionId
  let stopReason = "end_turn"
  let sawDelta = false
  const usage = { input: 0, output: 0, cacheRead: 0 }
  let failure: CliAgentError | null = null
  const stderr = new Response(proc.stderr).text()

  try {
    for await (const line of lines(proc.stdout)) {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.session_id && ev.session_id !== sessionId) {
        sessionId = ev.session_id
        run.onSession?.(ev.session_id)
      }
      if (ev.type === "stream_event") {
        const e = ev.event ?? {}
        if (e.type === "message_start") {
          sawDelta = false
          blockTool.clear()
        } else if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
          blockTool.set(e.index, { id: e.content_block.id, bytes: 0 })
          tools.start(e.content_block.id, e.content_block.name)
        } else if (e.type === "content_block_delta") {
          if (e.delta?.type === "text_delta") {
            sawDelta = true
            appendPart(run, "text", e.delta.text)
          } else if (e.delta?.type === "thinking_delta") {
            appendPart(run, "thinking", e.delta.thinking)
          } else if (e.delta?.type === "input_json_delta") {
            const t = blockTool.get(e.index)
            if (t) {
              t.bytes += String(e.delta.partial_json ?? "").length
              run.emit({ type: "tool_input_delta", id: t.id, bytes: t.bytes })
            }
          }
        }
      } else if (ev.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_use") {
            tools.start(block.id, block.name)
            tools.input(block.id, block.input)
          } else if (block.type === "text" && !sawDelta && !/^not logged in/i.test(String(block.text))) {
            // No partial chunks arrived for this message; show the finished text instead.
            appendPart(run, "text", block.text)
          }
        }
      } else if (ev.type === "user") {
        for (const block of Array.isArray(ev.message?.content) ? ev.message.content : [])
          if (block.type === "tool_result") tools.end(block.tool_use_id, Boolean(block.is_error), block.content)
      } else if (ev.type === "result") {
        usage.input += ev.usage?.input_tokens ?? 0
        usage.output += ev.usage?.output_tokens ?? 0
        usage.cacheRead += ev.usage?.cache_read_input_tokens ?? 0
        if (ev.is_error) {
          const text = String(ev.result ?? ev.subtype ?? "Claude Code failed")
          failure = /not logged in|\/login|invalid api key|oauth/i.test(text)
            ? new CliAgentError("claude_not_logged_in", "Claude Code 还没有登录。请在终端运行 claude，输入 /login 并用你的 Claude 订阅账号登录，然后重试。")
            : new CliAgentError("claude_code_error", `Claude Code 返回错误：${text.slice(0, 400)}`)
        } else if (ev.subtype && ev.subtype !== "success") stopReason = ev.subtype
      }
    }
    const code = await proc.exited
    tools.closeAll()
    if (run.signal.aborted) throw new CliAgentError("cancelled", "已停止。")
    if (failure) throw failure
    if (code !== 0) throw new CliAgentError("claude_code_error", `Claude Code 退出码 ${code}：${(await stderr).trim().slice(-400) || "没有错误输出"}`)
    return { sessionId, stopReason, usage }
  } finally {
    run.signal.removeEventListener("abort", onAbort)
    proc.kill()
  }
}

// ---- Codex (ChatGPT login) -------------------------------------------------------------

async function runCodex(run: CliRun): Promise<CliResult> {
  const cwd = await agentCwd("codex", run.projectId)
  // Codex reads its standing instructions from AGENTS.md in the working directory.
  await fs.writeFile(
    path.join(cwd, "AGENTS.md"),
    `${run.systemText}\n\nUse only the agenteda tools. Do not run shell commands and do not read or write files directly; every project file goes through read_file / write_file / edit_file.\n`,
  )
  const mcp = mcpSpec(run.projectId)
  const toml = (v: unknown) => JSON.stringify(v) // JSON strings and arrays of strings are valid TOML
  const envToml = `{${Object.entries(mcp.env)
    .map(([k, v]) => `${k}=${toml(v)}`)
    .join(",")}}`
  const options = [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config", // the user's own plugins and MCP servers stay out of this agent
    "-c",
    `mcp_servers.agenteda.command=${toml(mcp.command)}`,
    "-c",
    `mcp_servers.agenteda.args=${toml(mcp.args)}`,
    "-c",
    `mcp_servers.agenteda.env=${envToml}`,
    "-c",
    // Without this, non-interactive Codex refuses every MCP call that is not read-only.
    `mcp_servers.agenteda.default_tools_approval_mode="approve"`,
    "-c",
    "project_doc_max_bytes=65536",
  ]
  // The prompt is read from stdin ("-"), so user text is never parsed as a flag.
  const args = run.sessionId
    ? [run.bin, "exec", "resume", ...options, run.sessionId, "-"]
    : [run.bin, "exec", ...options, "-s", "read-only", "-C", cwd, "-"]
  const proc = Bun.spawn(args, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } })
  const onAbort = () => proc.kill()
  run.signal.addEventListener("abort", onAbort)
  proc.stdin.write(run.userText)
  await proc.stdin.end()

  const tools = toolTracker(run)
  // Codex numbers items from zero in every turn; make ids unique across the chat.
  const uid = (itemId: string) => `${run.reply.id}:${itemId}`
  // Codex reports a dropped connection as an error event ("Reconnecting...") and then carries on, so a bare
  // error is only held here: it counts if nothing follows it, and is forgotten as soon as the turn moves on.
  let unconfirmed: CliAgentError | null = null
  let sessionId = run.sessionId
  let stopReason = "end_turn"
  const usage = { input: 0, output: 0, cacheRead: 0 }
  let failure: CliAgentError | null = null
  const stderr = new Response(proc.stderr).text()

  try {
    for await (const line of lines(proc.stdout)) {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const item = ev.item
      const movedOn = ev.type === "turn.completed" || (String(ev.type).startsWith("item.") && item?.type !== "error")
      if (movedOn) unconfirmed = null
      if (ev.type === "thread.started" && ev.thread_id) {
        sessionId = ev.thread_id
        run.onSession?.(ev.thread_id)
      } else if ((ev.type === "item.started" || ev.type === "item.completed") && item?.type === "mcp_tool_call") {
        tools.start(uid(item.id), item.tool)
        if (ev.type === "item.started") tools.input(uid(item.id), item.arguments)
        else {
          tools.input(uid(item.id), item.arguments)
          const failed = item.status === "failed" || Boolean(item.error)
          tools.end(uid(item.id), failed || Boolean(item.result?.is_error ?? item.result?.isError), item.result?.content, item.error?.message)
        }
      } else if (ev.type === "item.completed" && item?.type === "agent_message") {
        // Separate consecutive messages; a message that follows a tool card starts its own block anyway.
        const last = run.reply.parts[run.reply.parts.length - 1]
        appendPart(run, "text", (last?.type === "text" ? "\n\n" : "") + String(item.text ?? ""))
      } else if (ev.type === "item.completed" && item?.type === "reasoning") {
        appendPart(run, "thinking", String(item.text ?? "") + "\n")
      } else if (ev.type === "item.completed" && item?.type === "error") {
        failure = new CliAgentError("codex_error", `Codex 报错：${String(item.message ?? "").slice(0, 400)}`)
      } else if (ev.type === "turn.completed") {
        usage.input += ev.usage?.input_tokens ?? 0
        usage.output += ev.usage?.output_tokens ?? 0
        usage.cacheRead += ev.usage?.cached_input_tokens ?? 0
      } else if (ev.type === "turn.failed" || ev.type === "error") {
        const text = String(ev.error?.message ?? ev.message ?? "Codex failed")
        const err = /login|unauthorized|401|auth/i.test(text)
          ? new CliAgentError("codex_not_logged_in", "Codex 还没有登录。请打开 ChatGPT / Codex 应用登录，或在终端运行 codex login，然后重试。")
          : new CliAgentError("codex_error", `Codex 返回错误：${text.slice(0, 400)}`)
        if (ev.type === "turn.failed") failure = err
        else unconfirmed = err
      }
    }
    const code = await proc.exited
    tools.closeAll()
    if (run.signal.aborted) throw new CliAgentError("cancelled", "已停止。")
    const failed = failure ?? unconfirmed
    if (failed) throw failed
    if (code !== 0) throw new CliAgentError("codex_error", `Codex 退出码 ${code}：${(await stderr).trim().slice(-400) || "没有错误输出"}`)
    return { sessionId, stopReason, usage }
  } finally {
    run.signal.removeEventListener("abort", onAbort)
    proc.kill()
  }
}

export function runCliAgent(run: CliRun): Promise<CliResult> {
  return run.provider === "claude-code" ? runClaudeCode(run) : runCodex(run)
}
