/**
 * Built-in chat agent: Claude drives the same tool table as the CLI / MCP server,
 * scoped to one project. Runs a manual streaming loop on the Messages API so every
 * token, tool call and build tick can be forwarded to the web UI.
 *
 * (Tools execute in this process against local project folders, so the loop is hosted
 * here rather than on Managed Agents.)
 */
import Anthropic from "@anthropic-ai/sdk"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { z } from "zod"
import { callTool, summarize, tools, PROJECT_AGENT_TOOLS, type ToolDef } from "./tools"
import { zodToJsonSchema } from "./schema"
import { GUIDE } from "./guide"
import { CliAgentError, codexLoggedIn, findClaudeCli, findCodexCli, runCliAgent } from "./agent-cli"
import { buildDir, readMeta, requireProject, ROOT } from "./engine/project"
import { renderPng } from "./engine/render"
import type { BuildProgress } from "./engine/build"

// ---- settings --------------------------------------------------------------

export type ProviderSetting = "auto" | "anthropic" | "claude-code" | "codex"

export interface AgentSettings {
  apiKey?: string
  baseURL?: string
  model: string
  effort: "low" | "medium" | "high" | "xhigh" | "max"
  /** Which engine runs the chat agent. "auto" picks the first one that is ready. */
  provider?: ProviderSetting
  /** Optional explicit paths to the agent CLIs */
  claudePath?: string
  codexPath?: string
}

const SETTINGS_FILE = path.join(ROOT, ".aeda-config.json")
const DEFAULTS: AgentSettings = { model: "claude-opus-5-5", effort: "high" }

export async function loadSettings(): Promise<AgentSettings> {
  let saved: Partial<AgentSettings> = {}
  if (existsSync(SETTINGS_FILE)) {
    try {
      saved = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"))
    } catch {}
  }
  return { ...DEFAULTS, ...saved }
}

export async function saveSettings(patch: Partial<AgentSettings>) {
  const next = { ...(await loadSettings()), ...patch }
  if (!next.apiKey) delete next.apiKey
  if (!next.baseURL) delete next.baseURL
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

/** What the UI may know about credentials: where they come from, never the value. */
function anthropicSource(s: AgentSettings): string | null {
  return s.apiKey
    ? "settings"
    : process.env.ANTHROPIC_API_KEY
      ? "ANTHROPIC_API_KEY"
      : process.env.ANTHROPIC_AUTH_TOKEN
        ? "ANTHROPIC_AUTH_TOKEN"
        : existsSync(path.join(process.env.HOME ?? "", ".config", "anthropic"))
          ? "ant profile"
          : null
}

export type ResolvedProvider = { kind: "anthropic" } | { kind: "claude-code" | "codex"; bin: string } | { kind: "none" }

/**
 * Decide which engine runs the chat. An explicit setting wins. "auto" prefers an Anthropic key,
 * then Codex when its login is present, then Claude Code (whose login cannot be checked without
 * running it; if it is not logged in the chat says so and how to fix it).
 */
export function resolveProvider(s: AgentSettings): ResolvedProvider {
  const claude = findClaudeCli(s.claudePath)
  const codex = findCodexCli(s.codexPath)
  const want = s.provider ?? "auto"
  if (want === "anthropic") return { kind: "anthropic" }
  if (want === "claude-code") return claude ? { kind: "claude-code", bin: claude } : { kind: "none" }
  if (want === "codex") return codex ? { kind: "codex", bin: codex } : { kind: "none" }
  if (anthropicSource(s)) return { kind: "anthropic" }
  if (codex && codexLoggedIn()) return { kind: "codex", bin: codex }
  if (claude) return { kind: "claude-code", bin: claude }
  if (codex) return { kind: "codex", bin: codex }
  return { kind: "none" }
}

/** What the UI may know about credentials: where they come from, never the value. */
export async function credentialStatus() {
  const s = await loadSettings()
  const source = anthropicSource(s)
  const resolved = resolveProvider(s)
  const claude = findClaudeCli(s.claudePath)
  const codex = findCodexCli(s.codexPath)
  return {
    // "configured" means: sending a chat message will reach some engine.
    configured: resolved.kind === "anthropic" ? source !== null : resolved.kind !== "none",
    source,
    model: s.model,
    effort: s.effort,
    baseURL: s.baseURL ?? null,
    provider: resolved.kind,
    providerSetting: s.provider ?? "auto",
    providers: {
      anthropic: { available: source !== null },
      claudeCode: { available: claude !== null },
      codex: { available: codex !== null, loggedIn: codex !== null && codexLoggedIn() },
    },
  }
}

// ---- tools -----------------------------------------------------------------

/** Tools the in-app agent gets: everything project-scoped, with `project` injected for it. */
const AGENT_TOOL_NAMES: readonly string[] = PROJECT_AGENT_TOOLS

function agentTools(eager: boolean): Anthropic.Beta.BetaToolUnion[] {
  const out: Anthropic.Beta.BetaToolUnion[] = []
  for (const name of AGENT_TOOL_NAMES) {
    const t = tools.find((x) => x.name === name) as ToolDef<any>
    const { project: _omit, ...shape } = t.shape as Record<string, z.ZodTypeAny>
    out.push({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(shape),
      ...(eager ? { eager_input_streaming: true } : {}),
    } as Anthropic.Beta.BetaTool)
  }
  out.push({
    name: "look",
    description:
      "Look at the last build as an image: 'pcb' (copper, pads, silkscreen), 'schematic', 'assembly', or 'simulation' (SPICE waveforms, when the design has probes). Use it after a build passes to judge placement and routing, and whenever the user asks about how the board looks.",
    input_schema: {
      type: "object",
      properties: { view: { type: "string", enum: ["pcb", "schematic", "assembly", "simulation"] } },
      required: ["view"],
      additionalProperties: false,
    },
    ...(eager ? { eager_input_streaming: true } : {}),
  } as Anthropic.Beta.BetaTool)
  return out
}

const SYSTEM_ROLE = `You are AgentEDA, a hardware engineer that turns a product idea into a manufacturable PCB.
You work inside one project. The user sees your messages in a chat panel next to a live preview of the schematic, PCB, 3D view and BOM, which refreshes after every build.

How you work:
- Start designing right away from a sensible reading of the request. Ask a question only when the answer would change the circuit and you cannot pick a safe default; otherwise choose, and state the assumption.
- Write the whole design to index.circuit.tsx, then build. Read the errors, fix, build again. Do not tell the user the board is done until build returns ok: true.
- For every IC, module and non-trivial connector, search_parts and import_part instead of guessing a footprint. Prefer in-stock, "basic" JLCPCB parts.
- After the build passes, look at the pcb once to check the placement is sane (connectors on edges, decoupling near pins), and improve it if it is clearly poor.
- Where the board has analog behaviour that can be checked (a divider, a filter, an LED current, a bias point), add a simulation testbench and compare the probe numbers in the build report with what you intended. Say what the simulation showed.
- Give supply rails that carry real current wider traces (thickness on the traces of that net) and every board with an IC a ground pour.
- Before you finish, write NOTES.md (calculated values, assumptions, what is unverified, known compromises); the user sees it in the "说明" tab.
- When the board passes, call export_fab so the manufacturing files are ready to download, and confirm its Gerber read-back verification is ok.

How you talk:
- Reply in the user's language.
- Keep messages short. Before a tool call, one sentence on what you are about to do. No code dumps in chat: the code is in the editor.
- Finish with a brief summary: what the board does, key parts and rails, board size, check status, the assumptions you made, and what the automated checks cannot verify (the user should review those before ordering).
- You are responsible for electrical correctness. The checks verify geometry and connectivity, not whether the circuit works.`

// ---- chat persistence ------------------------------------------------------

type ApiMessage = Anthropic.Beta.BetaMessageParam

export interface TranscriptItem {
  id: string
  role: "user" | "assistant"
  /** Ordered parts as the UI renders them */
  parts: (
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "tool"; id: string; name: string; input: any; ok?: boolean; summary?: string; result?: any; durationMs?: number }
    | { type: "error"; text: string }
  )[]
  at: string
}

interface ChatState {
  messages: ApiMessage[]
  transcript: TranscriptItem[]
  /** Session of the agent CLI that last ran this chat, so the next turn continues it */
  cli?: { provider: string; sessionId: string }
}

function chatFile(id: string) {
  return path.join(buildDir(id), "chat.json")
}

export async function loadChat(id: string): Promise<ChatState> {
  requireProject(id)
  const f = chatFile(id)
  if (!existsSync(f)) return { messages: [], transcript: [] }
  try {
    return JSON.parse(await fs.readFile(f, "utf8"))
  } catch {
    return { messages: [], transcript: [] }
  }
}

const saveQueue = new Map<string, Promise<void>>()

/**
 * Saves are queued per project and written to a temp file that is then renamed, so two saves
 * can never interleave and a reader never sees half a file (a corrupt chat.json reads as empty).
 */
function saveChat(id: string, state: ChatState): Promise<void> {
  const next = (saveQueue.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(buildDir(id), { recursive: true })
      const tmp = `${chatFile(id)}.tmp`
      await fs.writeFile(tmp, JSON.stringify(state))
      await fs.rename(tmp, chatFile(id))
    })
  saveQueue.set(id, next)
  return next
}

export async function clearChat(id: string) {
  requireProject(id)
  await fs.rm(chatFile(id), { force: true })
}

// ---- the loop --------------------------------------------------------------

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

const running = new Map<string, AbortController>()

export function isAgentRunning(id: string) {
  return running.has(id)
}

export function stopAgent(id: string) {
  running.get(id)?.abort()
}

/** Trim big tool results before they go back into the model's context. */
function forModel(result: unknown): string {
  const text = JSON.stringify(result)
  return text.length > 24_000 ? text.slice(0, 24_000) + '..."[truncated]"' : text
}

/** Trim what is kept in the UI transcript. */
function forUi(result: any) {
  const text = JSON.stringify(result)
  if (text.length <= 6000) return result
  return { truncated: true, preview: text.slice(0, 6000) }
}

export async function runAgent(projectId: string, userText: string, emit: (e: AgentEvent) => void): Promise<void> {
  requireProject(projectId)
  if (running.has(projectId)) {
    emit({ type: "error", code: "busy", message: "Agent 正在处理这个项目，请等它完成或先停止。" })
    return
  }
  const abort = new AbortController()
  running.set(projectId, abort)

  let settings: AgentSettings
  let meta: Awaited<ReturnType<typeof readMeta>>
  let state: ChatState
  try {
    settings = await loadSettings()
    meta = await readMeta(projectId)
    state = await loadChat(projectId)
  } catch (e: any) {
    // Never leave the project marked busy because setup failed.
    running.delete(projectId)
    emit({ type: "error", code: "agent_error", message: String(e?.message ?? e) })
    emit({ type: "done", stopReason: "agent_error", usage: { input: 0, output: 0, cacheRead: 0 } })
    return
  }
  const provider = resolveProvider(settings)
  const custom = Boolean(settings.baseURL)
  const client = new Anthropic({
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
  })

  state.messages.push({ role: "user", content: userText })
  state.transcript.push({
    id: `u${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text: userText }],
    at: new Date().toISOString(),
  })
  const reply: TranscriptItem = { id: `a${Date.now()}`, role: "assistant", parts: [], at: new Date().toISOString() }
  state.transcript.push(reply)
  emit({ type: "start", messageId: reply.id })
  // Persist right away: a page opened mid-run must see this turn, not attach its events to the previous reply.
  await saveChat(projectId, state).catch(() => {})

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    // Stable prefix first so it caches across turns and projects.
    { type: "text", text: `${SYSTEM_ROLE}\n\n${GUIDE}`, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Current project: "${meta.name}" (id ${meta.id}).${meta.description ? ` Requirement: ${meta.description}` : ""}` },
  ]
  // Against a proxy / gateway, send only the plain Messages surface.
  const toolDefs = agentTools(!custom)
  const usage = { input: 0, output: 0, cacheRead: 0 }
  let stopReason = "end_turn"
  let jsonRetries = 0

  const appendText = (kind: "text" | "thinking", delta: string) => {
    const last = reply.parts[reply.parts.length - 1]
    if (last && last.type === kind) last.text += delta
    else reply.parts.push({ type: kind, text: delta })
  }

  try {
    if (provider.kind === "none") {
      throw new CliAgentError(
        "no_provider",
        "还没有可用的模型：在设置里填写 Anthropic API Key，或安装并登录 Claude Code（Claude 订阅）或 Codex。",
      )
    } else if (provider.kind !== "anthropic") {
      // A local agent CLI runs the turn; it keeps its own conversation memory, keyed by session id.
      const resume = state.cli?.provider === provider.kind ? state.cli.sessionId : null
      // The API history is not used on this path; drop the user turn that was queued for it.
      state.messages.pop()
      const systemText = `${SYSTEM_ROLE}\n\n${GUIDE}\n\nCurrent project: "${meta.name}" (id ${meta.id}).${meta.description ? ` Requirement: ${meta.description}` : ""}\nThe agenteda tools are already bound to this project; they take no project argument. The tool for looking at the board is called render.`
      const kind = provider.kind
      const cliRun = (sessionId: string | null) =>
        runCliAgent({
          provider: kind,
          bin: provider.bin,
          projectId,
          userText,
          systemText,
          sessionId,
          reply,
          emit,
          signal: abort.signal,
          checkpoint: () => saveChat(projectId, state).catch(() => {}),
          // Remember the session as soon as the CLI names it, so a stopped or failed turn can still be continued.
          onSession: (id) => {
            state.cli = { provider: kind, sessionId: id }
          },
        })
      let out: Awaited<ReturnType<typeof runCliAgent>>
      try {
        out = await cliRun(resume)
      } catch (e) {
        // A stored session the CLI can no longer resume must not block the chat for good:
        // when nothing at all came back, start one fresh session instead.
        const dead = resume !== null && !abort.signal.aborted && reply.parts.length === 0 && e instanceof CliAgentError && !/not_logged_in/.test(e.code)
        if (!dead) throw e
        const stored = state.cli
        delete state.cli
        try {
          out = await cliRun(null)
        } catch (again) {
          // A fresh session that also gets nowhere means the stored one was not the problem
          // (no network, say), so keep it for the next turn.
          if (stored && reply.parts.length === 0) state.cli = stored
          throw again
        }
      }
      if (out.sessionId) state.cli = { provider: kind, sessionId: out.sessionId }
      usage.input += out.usage.input
      usage.output += out.usage.output
      usage.cacheRead += out.usage.cacheRead
      stopReason = out.stopReason
    } else
    for (let turn = 0; turn < 60; turn++) {
      const stream = client.beta.messages.stream(
        {
          model: settings.model,
          max_tokens: 64000,
          system,
          tools: toolDefs,
          messages: state.messages,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: settings.effort },
          ...(custom ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        },
        { signal: abort.signal },
      )

      const inputBytes = new Map<number, { id: string; bytes: number }>()
      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          inputBytes.set(event.index, { id: event.content_block.id, bytes: 0 })
          emit({ type: "tool_start", id: event.content_block.id, name: event.content_block.name })
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            appendText("text", event.delta.text)
            emit({ type: "text", delta: event.delta.text })
          } else if (event.delta.type === "thinking_delta") {
            appendText("thinking", event.delta.thinking)
            emit({ type: "thinking", delta: event.delta.thinking })
          } else if (event.delta.type === "input_json_delta") {
            const t = inputBytes.get(event.index)
            if (t) {
              t.bytes += event.delta.partial_json.length
              emit({ type: "tool_input_delta", id: t.id, bytes: t.bytes })
            }
          }
        }
      })

      let message: Anthropic.Beta.BetaMessage
      try {
        message = await stream.finalMessage()
        jsonRetries = 0
      } catch (err) {
        // Typed API errors and user aborts are real; anything else is an unparseable
        // tool input or a dropped connection, which is worth re-issuing a couple of times.
        if (err instanceof Anthropic.APIError || abort.signal.aborted || jsonRetries++ >= 2) throw err
        continue
      }

      usage.input += message.usage.input_tokens
      usage.output += message.usage.output_tokens
      usage.cacheRead += message.usage.cache_read_input_tokens ?? 0
      stopReason = message.stop_reason ?? "end_turn"

      if (stopReason === "refusal") {
        reply.parts.push({ type: "error", text: "模型拒绝了这个请求。" })
        emit({ type: "error", code: "refusal", message: "模型拒绝了这个请求。" })
        break
      }
      if (stopReason === "pause_turn") {
        state.messages.push({ role: "assistant", content: message.content as any })
        continue
      }

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      if (toolUses.length === 0) {
        // An assistant turn with no content would make every later request for this project invalid.
        if (message.content.length > 0) state.messages.push({ role: "assistant", content: message.content as any })
        else if (reply.parts.length === 0) {
          reply.parts.push({ type: "error", text: "模型这次没有返回内容，请再发送一次。" })
          emit({ type: "error", code: "empty_reply", message: "模型这次没有返回内容，请再发送一次。" })
        }
        break
      }
      if (stopReason === "max_tokens") {
        // A tool input cut off mid-way can still parse; never run it.
        reply.parts.push({ type: "error", text: "回复在生成工具调用时被截断了，发送“继续”让我接着做。" })
        emit({ type: "error", code: "max_tokens", message: "回复在生成工具调用时被截断。" })
        break
      }

      state.messages.push({ role: "assistant", content: message.content as any })

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const use of toolUses) {
        emit({ type: "tool_input", id: use.id, name: use.name, input: use.input })
        const part: Extract<TranscriptItem["parts"][number], { type: "tool" }> = {
          type: "tool",
          id: use.id,
          name: use.name,
          input: use.name === "write_file" ? { ...(use.input as any), content: undefined, bytes: String((use.input as any)?.content ?? "").length } : use.input,
        }
        reply.parts.push(part)
        const started = Date.now()

        if (abort.signal.aborted) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "Cancelled by the user." })
          continue
        }

        if (use.name === "look") {
          const view = (use.input as any)?.view
          try {
            if (!["pcb", "schematic", "assembly", "simulation"].includes(view)) throw new Error("view must be pcb, schematic, assembly or simulation")
            const png = await renderPng(projectId, view, 1100)
            results.push({
              type: "tool_result",
              tool_use_id: use.id,
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(png).toString("base64") } }],
            })
            Object.assign(part, { ok: true, summary: `Looked at the ${view}`, durationMs: Date.now() - started })
          } catch (e: any) {
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: String(e?.message ?? e) })
            Object.assign(part, { ok: false, summary: String(e?.message ?? e), durationMs: Date.now() - started })
          }
          emit({ type: "tool_end", id: use.id, name: use.name, ok: Boolean(part.ok), summary: part.summary ?? "", result: null, durationMs: part.durationMs ?? 0 })
          continue
        }

        // callTool validates the input against the tool's schema before running it,
        // which is what catches a silently truncated eager-streamed input.
        const args = { ...(use.input as object), project: projectId }
        const out = await callTool(use.name, args, {
          source: "agent",
          onProgress: (progress) => emit({ type: "tool_progress", id: use.id, progress }),
        })
        const summary = summarize(use.name, args, out)
        Object.assign(part, { ok: out.ok, summary, result: forUi(out.result), durationMs: Date.now() - started })
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content:
            !out.ok && out.result?.error?.code === "invalid_arguments"
              ? JSON.stringify({ INVALID_JSON: JSON.stringify(use.input), detail: out.result.error.message })
              : forModel(out.result),
          ...(out.ok ? {} : { is_error: true }),
        })
        emit({ type: "tool_end", id: use.id, name: use.name, ok: out.ok, summary, result: forUi(out.result), durationMs: Date.now() - started })
      }
      // All results for one assistant turn go back in a single user message.
      state.messages.push({ role: "user", content: results })
      await saveChat(projectId, state)
      if (abort.signal.aborted) {
        stopReason = "cancelled"
        break
      }
    }
  } catch (err: any) {
    let message: string
    let code = "agent_error"
    if (abort.signal.aborted) {
      message = "已停止。"
      code = "cancelled"
    } else if (err instanceof CliAgentError) {
      message = err.message
      code = err.code
    } else if (err instanceof Anthropic.AuthenticationError) {
      message = "模型密钥无效。请在设置里填写可用的 Anthropic API Key，或在启动服务前设置 ANTHROPIC_API_KEY。"
      code = "no_credentials"
    } else if (err instanceof Anthropic.PermissionDeniedError) {
      message = `当前密钥没有权限使用 ${settings.model}，请在设置里换一个模型。`
      code = "permission_denied"
    } else if (err instanceof Anthropic.NotFoundError) {
      message = `找不到模型 "${settings.model}"，请检查设置里的模型 ID。`
      code = "model_not_found"
    } else if (err instanceof Anthropic.RateLimitError) {
      message = "触发了 API 限流，稍等片刻再发送。"
      code = "rate_limited"
    } else if (err instanceof Anthropic.BadRequestError) {
      message = `API 拒绝了请求：${err.message}`
      code = "bad_request"
    } else if (err instanceof Anthropic.APIConnectionError) {
      message = "连接不上模型 API，请检查网络（以及设置里的 API 地址）。"
      code = "connection"
    } else if (err instanceof Anthropic.APIError) {
      message = `API 错误 ${err.status ?? ""}：${err.message}`
      code = "api_error"
    } else if (/apiKey|authToken|credentials/i.test(String(err?.message))) {
      // The SDK throws a plain Error at construction/first use when nothing resolves.
      message = "还没有模型密钥。请在设置里填写 Anthropic API Key，或在启动服务前设置 ANTHROPIC_API_KEY。"
      code = "no_credentials"
    } else {
      message = String(err?.message ?? err)
    }
    stopReason = code
    reply.parts.push({ type: "error", text: message })
    emit({ type: "error", code, message })
    // The API never saw an answer to the last user turn; if the history ends with a
    // dangling assistant tool_use, close it so the next request is valid.
    const last = state.messages[state.messages.length - 1]
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const dangling = (last.content as any[]).filter((b) => b.type === "tool_use")
      if (dangling.length)
        state.messages.push({
          role: "user",
          content: dangling.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, is_error: true, content: "Interrupted before this tool ran." })),
        })
    }
  } finally {
    // Save before releasing the project, so the next turn cannot load the chat ahead of this write.
    await saveChat(projectId, state).catch(() => {})
    running.delete(projectId)
    emit({ type: "done", stopReason, usage })
  }
}
