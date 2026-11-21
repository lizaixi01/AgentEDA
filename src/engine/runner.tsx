/**
 * Subprocess entry: compiles one tscircuit entry file to Circuit JSON.
 * Usage: bun run runner.tsx <entryFile> <outFile> [--no-parts]
 * Always writes a JSON envelope to <outFile>: { ok, circuitJson?, error? }
 * Runs isolated so a crashing / looping design cannot take down the host.
 */
import { Circuit } from "@tscircuit/core"
import { getPlatformConfig } from "tscircuit"
import { createElement, isValidElement } from "react"
import path from "node:path"

const [entry, outFile, ...flags] = process.argv.slice(2)
if (!entry || !outFile) {
  console.error("usage: runner.tsx <entry> <out> [--no-parts]")
  process.exit(2)
}
const noParts = flags.includes("--no-parts")

function serializeError(e: any, phase: string) {
  const stack = String(e?.stack ?? "")
  // Find the first frame inside the user's project (not node_modules)
  const frame = stack
    .split("\n")
    .map((l) => l.match(/\(?((?:\/|file:\/\/)[^():]+):(\d+):(\d+)\)?/))
    .find((m) => m && !m[1]!.includes("node_modules") && !m[1]!.includes("/src/engine/"))
  return {
    phase,
    message: String(e?.message ?? e),
    file: frame ? frame[1]!.replace("file://", "") : undefined,
    line: frame ? Number(frame[2]) : undefined,
    column: frame ? Number(frame[3]) : undefined,
    stack: stack.split("\n").slice(0, 8).join("\n"),
  }
}

async function main() {
  const started = Date.now()
  let mod: any
  try {
    mod = await import(path.resolve(entry!))
  } catch (e) {
    return { ok: false, error: serializeError(e, "import") }
  }
  const exported = mod.default ?? mod.circuit ?? mod.Board ?? Object.values(mod).find((v) => typeof v === "function")
  if (!exported) {
    return {
      ok: false,
      error: {
        phase: "import",
        message:
          "Entry file has no default export. Export a component: `export default () => (<board>...</board>)`",
      },
    }
  }
  try {
    const platform: any = getPlatformConfig()
    if (noParts) delete platform.partsEngine
    const circuit = new Circuit({ platform } as any)
    const element = isValidElement(exported) ? exported : createElement(exported as any)
    circuit.add(element as any)
    await circuit.renderUntilSettled()
    const circuitJson = circuit.getCircuitJson()
    return { ok: true, circuitJson, renderMs: Date.now() - started }
  } catch (e) {
    return { ok: false, error: serializeError(e, "render") }
  }
}

const result = await main()
await Bun.write(outFile, JSON.stringify(result))
process.exit(0)
