---
name: agenteda
description: Design real, manufacturable PCBs with AgentEDA. Use when the user asks to design, modify, check or export a circuit board, schematic, PCB layout, BOM or JLCPCB/嘉立创 manufacturing files (Gerber, BOM, CPL), or mentions AgentEDA. Covers writing the board as code, the build-and-fix verification loop, sourcing parts from LCSC, and exporting order files.
---

# AgentEDA

AgentEDA turns a board description into fab-ready files. A board is one TSX file. `build` compiles it,
places parts, autoroutes copper, matches JLCPCB parts and runs ERC/DRC. You iterate on the report
until it passes, then export Gerber + BOM + CPL.

## How to call it

Use whichever interface is available. They expose the same tools and return the same JSON.

- **MCP** (preferred): tools named `get_guide`, `create_project`, `build`, ... on the `agenteda` server.
  Install once: `claude mcp add agenteda -- bun run <AgentEDA repo>/src/mcp.ts`
- **CLI**: `<AgentEDA repo>/bin/aeda <tool> [project] [--arg value]` (a wrapper around `bun src/cli.ts`; `aeda help` lists everything). Output is JSON; exit code 1 means the tool call itself failed (bad arguments, unknown project). A build that finds design errors still exits 0: read `ok` in the JSON.
  Large arguments can come from a file: `--content @board.tsx`.
- **HTTP** (when the web app is running): `POST http://127.0.0.1:4477/api/tools/<tool>` with a JSON body.

The web app at `http://127.0.0.1:4477` shows the schematic, PCB, 3D view, BOM and checks, and refreshes
live while you work. Tell the user they can watch there.

## Workflow

1. **Read the guide first**: `get_guide` (CLI: `aeda guide`). It has the TSX syntax, footprint names, verified part numbers and worked examples. Do not write a design from memory of other EDA tools.
2. `list_templates`. If a template is close, `create_project` with `template` and adapt it. Otherwise `create_project` with a name and the requirement as `description`.
3. For every IC, module, connector, LED or diode that is not in the guide's verified table: `search_parts` (known part number) or `browse_parts` (known kind of part), then `import_part`. Use the returned import line and pin names. Never guess a footprint or a pinout.
4. `write_file` the whole design to `index.circuit.tsx`.
5. `build`. Read `errors` first; each has a `hint`. Fix with `edit_file` and build again. Repeat until `ok` is `true`.
6. `render` to look at the PCB once it passes (MCP returns the image; the CLI writes a PNG and returns its path). Fix obviously bad placement.
7. For analog behaviour (dividers, filters, bias, LED current), add a simulation testbench (see the guide) and compare `simulation.probes` in the build report with what the circuit should do.
8. `export_fab`. Check that `verification.ok` is true (the Gerbers are read back by an independent parser). Report the file paths.
9. Write `NOTES.md` in the project (`write_file` with `path: "NOTES.md"`): what the board does, calculated values, assumptions, what you did not verify against a datasheet, known compromises. The web app shows it beside the board.

## Rules

- A board is not done until `build` returns `ok: true`. Do not describe a board as finished, working or ready on the strength of having written the code.
- Fix the first error first. `unrouted_connections` usually follows from a placement error above it.
- Change one thing per build when debugging; compare `summary` before and after. `restore_version` undoes a bad turn.
- Warnings are not all noise. `bom_part_not_sourced` matters for anything JLCPCB should assemble. `unconnected_pins` matters for power, ground, enable and reset pins.
- The checks verify geometry and connectivity. They do not verify that the circuit does what the user wants. Electrical correctness (voltages, currents, pull-ups, decoupling, pinout against the datasheet) is your job; say what you assumed and what the user should review before ordering.
- Never place an order or upload files anywhere. Hand the files to the user.

## Reporting back

Keep it short: what the board does, key parts and rails, size and layers, check status (errors, warnings,
routed connections), BOM cost if available, where the fab files are, the assumptions you made, and what
automated checks cannot verify.

## Tool reference

| Tool | Use |
|---|---|
| `get_guide` | Syntax, footprints, verified parts, examples. Read once per session. |
| `list_templates` / `create_project` | Start a project (blank, from code, or from a verified template). |
| `list_projects` / `list_files` / `read_file` | Find and inspect existing work. |
| `write_file` / `edit_file` | Change the design. Neither builds. |
| `place_component` | Move one part: sets pcbX / pcbY / pcbRotation / layer on the element with that name. |
| `build` | Compile, place, route, check. `detail: true` adds component pin names, positions, netlist, BOM. |
| `get_report` | Last build's report without rebuilding. |
| `render` | PNG of `pcb`, `schematic`, `assembly` or `simulation` waveforms. |
| `search_parts` / `browse_parts` | Find a part by number / keywords, or by category with attribute filters (voltage rating, colour, pitch ...). |
| `import_part` | Import the exact footprint + pins of an LCSC part as a component; returns pad geometry. |
| `export_fab` | `gerbers.zip`, `bom.csv`, `cpl.csv`, KiCad files, bundle zip. Refuses while there are errors. |
| `export_report` | One self-contained HTML design report for a human reviewer. |
| `export_3d` | GLB model of the assembled board. |
| `list_versions` / `restore_version` | Every build snapshots the sources. |

Errors come back as `{ "error": { "code", "message", "hint" } }`. Follow the hint.
