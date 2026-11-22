# AgentEDA

Agent-native PCB design tool. A board is one TSX file (tscircuit); `build` compiles, places, routes,
checks and reports. Read `README.md` for usage and `src/guide.ts` for the design language.

## Layout

- `src/engine/` compile (`runner.tsx`, subprocess), `analyze.ts` (report, DFM, simulation stats), `build.ts`, `export.ts`, `parts.ts`, `project.ts`
- `src/agent.ts` the chat agent and provider choice; `src/agent-cli.ts` runs it on a local agent CLI (Claude Code on a Claude subscription, or Codex) through the MCP server in pinned mode (`AEDA_PIN_PROJECT`)
- `src/tools.ts` the one tool table. CLI (`cli.ts`), MCP (`mcp.ts`), HTTP (`server.ts`) and the chat agent (`agent.ts`) are adapters over it. Add a capability here, not in an adapter.
- `web/` Vite + React + Tailwind v4 + shadcn/ui (Base UI flavour: use the `render` prop, not `asChild`)
- `templates/` verified boards; `skills/agenteda/` skill for outside agents; `tests/` end-to-end tests

## Commands

- `bun run dev` server with reload on :4477 (serves `web/dist`)
- `bun run build:web` rebuild the UI after changing `web/`
- `bun run typecheck` and `bun test tests` before calling a change done (tests compile real boards; they need network)
- `bun src/cli.ts <tool> ...` to exercise a tool directly

## Gotchas

- `bun run dev` reloads on any change under `src/`, which kills a chat-agent run in flight. Do not edit `src/` while testing a chat turn.
- The HTTP API refuses requests whose Origin is not its own page (see `guard` in `src/server.ts`); tools without an Origin header (curl, the CLI, tests) pass.
- `bun test` runs all test files in one process and they share loaded modules, while `PROJECTS_DIR` is fixed the first time `src/engine/project.ts` is imported. `tests/engine.test.ts` is the one file that loads `src/` in-process (it sets `AEDA_PROJECTS_DIR` first). Any other test that imports `src/` would send the engine tests into the real `projects/` folder: drive `src/` from a subprocess instead, as `tests/agent-cli.test.ts` does through `tests/cli-agent-driver.ts`.

## Rules

- zod must stay on v3 (tscircuit breaks on v4).
- Every claim in `src/guide.ts` must be something a build has confirmed; the guide's complete example and every template are built by the test suite. When you learn a new fact the hard way, put it in the guide.
- Diagnostics are for agents: stable `code`, a `message` with the specifics, a `hint` that says what to change. Fold cascades into one line.
- Never report a board as fab-ready on anything but `build` returning `ok: true`.
- Fab limits in `analyze.ts` (`JLCPCB_2L`) come from JLCPCB's capabilities page; re-read the page before changing them.
