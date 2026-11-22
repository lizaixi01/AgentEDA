/**
 * The local-CLI agent path, driven by a stand-in for the Codex binary that replays an event stream.
 * No model and no network: this pins how Codex's events are read, not what a model does.
 *
 * Each turn runs in its own process (cli-agent-driver.ts). Nothing from src/ is imported here, so this
 * file cannot fix the projects directory for the test files that run after it.
 */
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aeda-cli-test-"))
const projectId = `cli-stub-${process.pid}`
const driver = path.join(import.meta.dir, "cli-agent-driver.ts")

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(path.join(os.tmpdir(), "agenteda-agent", "codex", projectId), { recursive: true, force: true })
})

/** A fake `codex`: swallows the prompt, prints the given events one per line, exits with the given code. */
function fakeCodex(name: string, events: unknown[], exitCode = 0) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir)
  const stream = path.join(dir, "events.jsonl")
  fs.writeFileSync(stream, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  const bin = path.join(dir, "codex")
  fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat "${stream}"\nexit ${exitCode}\n`, { mode: 0o755 })
  return bin
}

interface Outcome {
  parts: { type: string; text?: string }[]
  emitted: string[]
  sessions: string[]
  result: { sessionId: string | null; stopReason: string; usage: { input: number; output: number; cacheRead: number } } | null
  error: { code: string | null; message: string } | null
}

function turn(bin: string, sessionId = ""): Outcome {
  const run = Bun.spawnSync([process.execPath, "run", driver, bin, projectId, sessionId], {
    env: { ...process.env, AEDA_PROJECTS_DIR: path.join(tmp, "projects") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = run.stdout.toString().trim()
  if (run.exitCode !== 0 || !out) throw new Error(`driver failed (${run.exitCode}): ${run.stderr.toString().slice(-600)}`)
  return JSON.parse(out.split("\n").pop()!)
}

const RECONNECT = { type: "error", message: "Reconnecting... waiting for network (Connection failed: error sending request)" }
const STARTED = { type: "thread.started", thread_id: "thread-1" }
const ANSWER = { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "构建通过。" } }
const COMPLETED = { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }

describe("codex event stream", () => {
  test("a reconnect notice followed by a finished turn is not a failure", () => {
    const r = turn(fakeCodex("recovered", [STARTED, { type: "turn.started" }, RECONNECT, ANSWER, COMPLETED]))
    expect(r.error).toBeNull()
    expect(r.parts).toEqual([{ type: "text", text: "构建通过。" }])
    expect(r.result).toEqual({ sessionId: "thread-1", stopReason: "end_turn", usage: { input: 10, output: 3, cacheRead: 2 } })
    expect(r.sessions).toEqual(["thread-1"])
    expect(r.emitted).not.toContain("error")
  })

  test("carrying on after the notice is enough, with or without a closing event", () => {
    const r = turn(fakeCodex("carried-on", [STARTED, RECONNECT, RECONNECT, ANSWER]))
    expect(r.error).toBeNull()
    expect(r.parts).toEqual([{ type: "text", text: "构建通过。" }])
  })

  test("a turn that fails after the notice is still a failure", () => {
    const failed = { type: "turn.failed", error: { message: "stream disconnected before completion: network unreachable" } }
    const r = turn(fakeCodex("gave-up", [STARTED, RECONNECT, failed], 1), "thread-1")
    expect(r.error?.code).toBe("codex_error")
    expect(r.error?.message).toContain("stream disconnected")
    expect(r.parts).toEqual([])
  })

  test("a notice with nothing after it is reported as the error", () => {
    const r = turn(fakeCodex("died", [STARTED, ANSWER, RECONNECT], 1))
    expect(r.error?.code).toBe("codex_error")
    expect(r.error?.message).toContain("Reconnecting")
  })

  test("a failure that says the login is missing keeps its own code", () => {
    const r = turn(fakeCodex("logged-out", [STARTED, { type: "turn.failed", error: { message: "401 Unauthorized" } }], 1))
    expect(r.error?.code).toBe("codex_not_logged_in")
  })
})
