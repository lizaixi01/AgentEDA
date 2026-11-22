/**
 * Runs one CLI-agent turn against the binary named on the command line and prints what came of it.
 * Used by agent-cli.test.ts, which starts it as its own process: importing anything from src/ fixes the
 * projects directory for the whole process, and the test runner shares one process between test files.
 *
 *   bun run tests/cli-agent-driver.ts <codex binary> <project id> [session id]
 */
import { CliAgentError, runCliAgent } from "../src/agent-cli"
import type { AgentEvent, TranscriptItem } from "../src/agent"

const [bin, projectId, sessionId] = process.argv.slice(2)
if (!bin || !projectId) throw new Error("usage: cli-agent-driver.ts <codex binary> <project id> [session id]")

const reply: TranscriptItem = { id: "reply-1", role: "assistant", parts: [], at: new Date().toISOString() }
const emitted: AgentEvent[] = []
const sessions: string[] = []
let result: unknown = null
let error: { code: string | null; message: string } | null = null
try {
  result = await runCliAgent({
    provider: "codex",
    bin,
    projectId,
    userText: "rebuild",
    systemText: "system",
    sessionId: sessionId || null,
    reply,
    emit: (e) => emitted.push(e),
    signal: new AbortController().signal,
    onSession: (id) => sessions.push(id),
  })
} catch (e) {
  error = { code: e instanceof CliAgentError ? e.code : null, message: String((e as Error)?.message ?? e) }
}
console.log(JSON.stringify({ parts: reply.parts, emitted: emitted.map((e) => e.type), sessions, result, error }))
