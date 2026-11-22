/**
 * End-to-end checks of the engine through the same tool table every interface uses.
 * These compile real boards, so they need network access for the JLCPCB part lookup
 * unless noted (`no_parts`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aeda-test-"))
process.env.AEDA_PROJECTS_DIR = tmp
// Projects must sit under the repo so `tscircuit` / `react` resolve from node_modules.
const projectsDir = path.resolve(import.meta.dir, "..", "projects", `.test-${Date.now()}`)
process.env.AEDA_PROJECTS_DIR = projectsDir

const { callTool } = await import("../src/tools")
const { dfmCheck, JLCPCB_2L } = await import("../src/engine/analyze")

const call = async (name: string, args: Record<string, unknown> = {}) => callTool(name, args, { source: "cli" })

const GOOD = `export default () => (
  <board width="20mm" height="15mm">
    <resistor name="R1" resistance="1k" footprint="0402" />
    <led name="D1" color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} />
    <pinheader name="J1" pinCount={2} pitch="2.54mm" pinLabels={["VCC", "GND"]} />
    <trace from="J1.VCC" to="R1.pin1" />
    <trace from="R1.pin2" to="D1.anode" />
    <trace from="D1.cathode" to="J1.GND" />
  </board>
)
`

let project = ""

beforeAll(async () => {
  const r = await call("create_project", { name: "test board", code: GOOD })
  expect(r.ok).toBe(true)
  project = r.result.project
})

afterAll(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("project files", () => {
  test("paths cannot escape the project", async () => {
    const r = await call("write_file", { project, path: "../../evil.txt", content: "x" })
    expect(r.ok).toBe(false)
    expect(r.result.error.code).toBe("bad_path")
  })

  test("build output folder is read-only to tools", async () => {
    const r = await call("write_file", { project, path: ".aeda/report.json", content: "{}" })
    expect(r.ok).toBe(false)
    expect(r.result.error.code).toBe("bad_path")
  })

  test("edit_file refuses ambiguous and missing matches", async () => {
    const missing = await call("edit_file", { project, old_string: "does not exist", new_string: "x" })
    expect(missing.result.error.code).toBe("edit_no_match")
    const ambiguous = await call("edit_file", { project, old_string: "footprint=", new_string: "footprint=" })
    expect(ambiguous.result.error.code).toBe("edit_ambiguous")
  })

  test("unknown tool and bad arguments return structured errors", async () => {
    expect((await call("nope")).result.error.code).toBe("unknown_tool")
    expect((await call("build", {})).result.error.code).toBe("invalid_arguments")
    expect((await call("build", { project: "missing-project" })).result.error.code).toBe("project_not_found")
  })
})

describe("build loop", () => {
  test("a correct board builds, routes fully and is sourced", async () => {
    const r = await call("build", { project, detail: true })
    expect(r.ok).toBe(true)
    const rep = r.result
    expect(rep.ok).toBe(true)
    expect(rep.summary.components).toBe(3)
    expect(rep.summary.connectionsRouted).toBe(rep.summary.connectionsTotal)
    expect(rep.summary.connectionsTotal).toBe(3)
    expect(rep.summary.bomSourced).toBe(rep.summary.bomLines)
    expect(rep.nets.find((n: any) => n.pins.includes("D1.anode")).pins).toContain("R1.pin2")
  }, 120_000)

  test("a syntax error is reported as compile_failed with a location", async () => {
    await call("write_file", { project, content: GOOD.replace("</board>", "</bored>") })
    const r = await call("build", { project, no_parts: true })
    expect(r.result.status).toBe("compile_failed")
    expect(r.result.ok).toBe(false)
    expect(r.result.errors[0].code).toMatch(/^compile_/)
  }, 60_000)

  test("a wrong pin name is an error, not a silent pass", async () => {
    await call("write_file", { project, content: GOOD.replace("D1.anode", "D1.nope") })
    const r = await call("build", { project, no_parts: true })
    expect(r.result.ok).toBe(false)
    expect(JSON.stringify(r.result.errors)).toContain("nope")
  }, 60_000)

  test("a part outside the board blocks routing and says how to fix it", async () => {
    await call("write_file", { project, content: GOOD.replace('name="R1"', 'name="R1" pcbX={30}') })
    const r = await call("build", { project, no_parts: true })
    expect(r.result.ok).toBe(false)
    const codes = r.result.errors.map((e: any) => e.code)
    expect(codes).toContain("pcb_component_outside_board_error")
    // the cascade of per-pin errors is folded into one line
    expect(codes.filter((c: string) => c === "unrouted_connections").length).toBe(1)
    expect(r.result.errors.every((e: any) => e.code !== "pcb_port_not_connected_error")).toBe(true)
  }, 60_000)

  test("export is refused while the design has errors", async () => {
    const r = await call("export_fab", { project })
    expect(r.ok).toBe(false)
    expect(r.result.error.code).toBe("design_has_errors")
  })

  test("versions are recorded and can be restored", async () => {
    const v = await call("list_versions", { project })
    expect(v.result.versions.length).toBeGreaterThanOrEqual(4)
    const first = v.result.versions[0].version
    expect((await call("restore_version", { project, version: first })).ok).toBe(true)
    const file = await call("read_file", { project })
    expect(file.result.content).toBe(GOOD)
  })

  test("export produces fab files that an independent Gerber parser reads back", async () => {
    const b = await call("build", { project })
    expect(b.result.ok).toBe(true)
    const r = await call("export_fab", { project })
    expect(r.ok).toBe(true)
    const names = r.result.files.map((f: any) => f.name)
    for (const n of ["gerbers.zip", "bom.csv", "cpl.csv"]) expect(names).toContain(n)
    expect(r.result.verification.ok).toBe(true)
    expect(r.result.verification.missing).toEqual([])
    expect(r.result.verification.sizeMm).toEqual({ width: 20, height: 15 })
    const bom = fs.readFileSync(path.join(projectsDir, project, ".aeda", "fab", "bom.csv"), "utf8")
    expect(bom).toContain("C2286")
    // the design report is one offline file with no scripts and the notes escaped
    await call("write_file", { project, path: "NOTES.md", content: "# Notes\n\n- R1 limits LED current <script>alert(1)</script>\n" })
    const rep = await call("export_report", { project })
    expect(rep.ok).toBe(true)
    const html = fs.readFileSync(rep.result.file, "utf8")
    expect(html).toContain("test board")
    expect(html).toContain("C2286")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    // a rebuild invalidates the export
    await call("build", { project, no_parts: true })
    expect(fs.existsSync(path.join(projectsDir, project, ".aeda", "fab"))).toBe(false)
  }, 180_000)
})

describe("place_component", () => {
  test("sets, replaces and adds placement props on single-line and multi-line elements", async () => {
    const r = await call("create_project", {
      name: "placement",
      code: `export default () => (
  <board width="20mm" height="15mm">
    <resistor name="R1" resistance="1k" footprint="0402" />
    <chip
      name="U1"
      footprint="soic8"
      pcbX={0}
      pinLabels={{ pin1: "A", pin2: "B" }}
    />
    {[0, 1].map((i) => (
      <resistor key={i} name={\`RL\${i}\`} resistance="1k" footprint="0402" />
    ))}
  </board>
)
`,
    })
    const project = r.result.project
    expect((await call("place_component", { project, name: "R1", x: 3.5, y: -2, rotation: 90 })).ok).toBe(true)
    expect((await call("place_component", { project, name: "U1", x: 4, layer: "bottom" })).ok).toBe(true)
    const src = (await call("read_file", { project })).result.content as string
    expect(src).toContain('<resistor name="R1" resistance="1k" footprint="0402" pcbX={3.5} pcbY={-2} pcbRotation={90} />')
    expect(src).toContain("pcbX={4}")
    expect(src).not.toContain("pcbX={0}")
    expect(src).toContain('layer="bottom"')
    // nested braces in other props survive
    expect(src).toContain('pinLabels={{ pin1: "A", pin2: "B" }}')
    const loop = await call("place_component", { project, name: "RL0", x: 1 })
    expect(loop.result.error.code).toBe("component_not_found")
    const none = await call("place_component", { project, name: "R1" })
    expect(none.result.error.code).toBe("invalid_arguments")
  })
})

describe("dfm", () => {
  test("flags a trace thinner than the fab limit and passes a normal one", () => {
    const board = (width: number) => [
      { type: "pcb_trace", route: [{ route_type: "wire", x: 0, y: 0, width, layer: "top" }, { route_type: "wire", x: 1, y: 0, width, layer: "top" }] },
      { type: "pcb_via", hole_diameter: 0.2, outer_diameter: 0.3 },
    ]
    const thin = dfmCheck(board(0.05)).find((r) => r.id === "trace_width")!
    expect(thin.status).toBe("fail")
    expect(thin.limit).toBe(JLCPCB_2L.minTraceWidth)
    expect(dfmCheck(board(0.15)).find((r) => r.id === "trace_width")!.status).toBe("pass")
    expect(dfmCheck(board(0.15)).find((r) => r.id === "npth")!.status).toBe("n/a")
  })
})

describe("simulation", () => {
  test("an RC divider testbench reports the expected node voltage", async () => {
    const r = await call("create_project", {
      name: "divider sim",
      code: `export default () => (
  <board width="20mm" height="12mm">
    <resistor name="R1" resistance="10k" footprint="0603" />
    <resistor name="R2" resistance="10k" footprint="0603" />
    <pinheader name="J1" pinCount={3} pitch="2.54mm" pinLabels={["VIN", "MID", "GND"]} />
    <trace from="J1.VIN" to="net.SUPPLY" />
    <trace from="R1.pin1" to="net.SUPPLY" />
    <trace from="R1.pin2" to="net.MIDNODE" />
    <trace from="R2.pin1" to="net.MIDNODE" />
    <trace from="J1.MID" to="net.MIDNODE" />
    <trace from="R2.pin2" to="net.GND" />
    <trace from="J1.GND" to="net.GND" />
    <voltagesource name="V1" voltage="5V" />
    <trace from="V1.pin1" to="net.SUPPLY" />
    <trace from="V1.pin2" to="net.GND" />
    <voltageprobe name="VP_MID" connectsTo="J1.MID" />
    <analogsimulation duration="1ms" timePerStep="0.01ms" spiceEngine="ngspice" />
  </board>
)
`,
    })
    const b = await call("build", { project: r.result.project, no_parts: true })
    expect(b.result.errors).toEqual([])
    const probe = b.result.simulation.probes.find((p: any) => p.name === "VP_MID")
    expect(probe.finalV).toBeCloseTo(2.5, 2)
    // the source is a testbench element, not a part on the board
    expect(b.result.summary.components).toBe(3)
    expect(b.result.summary.connectionsRouted).toBe(b.result.summary.connectionsTotal)
  }, 120_000)
})

describe("templates", () => {
  test("every shipped template builds with no errors and routes fully", async () => {
    const { result } = await call("list_templates")
    expect(result.templates.length).toBeGreaterThanOrEqual(4)
    for (const t of result.templates) {
      const created = await call("create_project", { template: t.id })
      expect(created.ok).toBe(true)
      const b = await call("build", { project: created.result.project })
      expect({ template: t.id, errors: b.result.errors }).toEqual({ template: t.id, errors: [] })
      expect(b.result.summary.connectionsRouted).toBe(b.result.summary.connectionsTotal)
      expect(b.result.summary.bomSourced).toBe(b.result.summary.bomLines)
    }
  }, 600_000)

  test("the guide's complete example builds", async () => {
    const { GUIDE } = await import("../src/guide")
    const code = GUIDE.split("## Complete example")[1]!.match(/```tsx\n([\s\S]*?)```/)![1]!
    const created = await call("create_project", { name: "guide example", code })
    const b = await call("build", { project: created.result.project })
    expect(b.result.errors).toEqual([])
    expect(b.result.ok).toBe(true)
  }, 180_000)
})

describe("electrical rules", () => {
  const net = (name: string, pins: string[], extra: object = {}) => ({ name, pins, ...extra })
  test("flags the classic omissions and stays quiet on a correct circuit", async () => {
    const { electricalRules } = await import("../src/engine/erc")
    const components = [
      { name: "J1", kind: "connector", pins: ["VBUS1", "VBUS2", "GND1", "CC1", "CC2"] },
      { name: "U1", kind: "chip", pins: ["VDD", "GND", "SDA", "SCL"] },
      { name: "D1", kind: "led", pins: ["anode", "cathode"] },
    ]
    const bad = electricalRules(components, [
      net("VBUS", ["J1.VBUS1", "J1.VBUS2", "U1.VDD", "D1.anode"], { isPower: true }),
      net("GND", ["J1.GND1", "D1.cathode"], { isGround: true }),
      net("SDA", ["U1.SDA", "J1.CC1x"]),
      net("N1", ["U1.GND"]),
    ]).map((d) => d.code)
    expect(bad).toContain("erc_led_no_resistor")
    expect(bad).toContain("erc_usb_c_cc")
    expect(bad).toContain("erc_missing_decoupling")
    expect(bad).toContain("erc_power_pin_unconnected")
    expect(bad).toContain("erc_i2c_no_pullup")

    const good = electricalRules(
      [
        ...components,
        { name: "R1", kind: "resistor", pins: ["pin1", "pin2"] },
        { name: "R2", kind: "resistor", pins: ["pin1", "pin2"] },
        { name: "R3", kind: "resistor", pins: ["pin1", "pin2"] },
        { name: "R4", kind: "resistor", pins: ["pin1", "pin2"] },
        { name: "R5", kind: "resistor", pins: ["pin1", "pin2"] },
        { name: "C1", kind: "capacitor", pins: ["pin1", "pin2"] },
      ],
      [
        net("VBUS", ["J1.VBUS1", "J1.VBUS2", "U1.VDD", "R3.pin1", "C1.pin1", "R4.pin1", "R5.pin1"], { isPower: true }),
        net("GND", ["J1.GND1", "U1.GND", "D1.cathode", "R1.pin2", "R2.pin2", "C1.pin2"], { isGround: true }),
        net("N1", ["J1.CC1", "R1.pin1"]),
        net("N2", ["J1.CC2", "R2.pin1"]),
        net("N3", ["R3.pin2", "D1.anode"]),
        net("SDA", ["U1.SDA", "R4.pin2"]),
        net("SCL", ["U1.SCL", "R5.pin2"]),
      ],
    )
    expect(good).toEqual([])
  })
})

describe("independent spacing check", () => {
  const port = (id: string, net: string) => [
    { type: "source_port", source_port_id: `s${id}`, source_component_id: "c", name: id, subcircuit_connectivity_map_key: net },
    { type: "pcb_port", pcb_port_id: `p${id}`, source_port_id: `s${id}` },
  ]
  const trace = (id: string, portId: string, pts: [number, number][], layer = "top") => ({
    type: "pcb_trace",
    pcb_trace_id: id,
    route: pts.map(([x, y], i) => ({ route_type: "wire", x, y, width: 0.15, layer, ...(i === 0 ? { start_pcb_port_id: portId } : {}) })),
  })
  const base = [{ type: "source_component", source_component_id: "c", name: "X" }, ...port("a", "netA"), ...port("b", "netB")]

  test("finds a short, a too-small gap, and passes a legal one", async () => {
    const { clearanceCheck } = await import("../src/engine/clearance")
    const crossing = clearanceCheck([...base, trace("t1", "pa", [[0, 0], [10, 0]]), trace("t2", "pb", [[5, -5], [5, 5]])], 0.1)
    expect(crossing.violations.length).toBe(1)
    expect(crossing.violations[0]!.gapMm).toBe(0)

    // centre lines 0.2 mm apart, 0.15 mm wide -> 0.05 mm gap
    const tight = clearanceCheck([...base, trace("t1", "pa", [[0, 0], [10, 0]]), trace("t2", "pb", [[0, 0.2], [10, 0.2]])], 0.1)
    expect(tight.minGapMm).toBeCloseTo(0.05, 3)
    expect(tight.violations.length).toBe(1)

    const legal = clearanceCheck([...base, trace("t1", "pa", [[0, 0], [10, 0]]), trace("t2", "pb", [[0, 0.3], [10, 0.3]])], 0.1)
    expect(legal.minGapMm).toBeCloseTo(0.15, 3)
    expect(legal.violations).toEqual([])
  })

  test("ignores same-net copper and copper on different layers", async () => {
    const { clearanceCheck } = await import("../src/engine/clearance")
    const sameNet = clearanceCheck([...base, trace("t1", "pa", [[0, 0], [10, 0]]), trace("t2", "pa", [[5, -5], [5, 5]])], 0.1)
    expect(sameNet.violations).toEqual([])
    const otherLayer = clearanceCheck([...base, trace("t1", "pa", [[0, 0], [10, 0]]), trace("t2", "pb", [[5, -5], [5, 5]], "bottom")], 0.1)
    expect(otherLayer.violations).toEqual([])
  })

  test("a pad of another net under a trace is a short", async () => {
    const { clearanceCheck } = await import("../src/engine/clearance")
    const pad = { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_port_id: "pb", layer: "top", shape: "rect", x: 5, y: 0, width: 1, height: 0.6 }
    const r = clearanceCheck([...base, trace("t1", "pa", [[0, 0], [10, 0]]), pad], 0.1)
    expect(r.violations[0]!.gapMm).toBe(0)
  })
})

describe("layout versus netlist", () => {
  const comp = { type: "source_component", source_component_id: "c", name: "X" }
  const pin = (id: string, net: string, x: number, y: number, layer = "top") => [
    { type: "source_port", source_port_id: `s${id}`, source_component_id: "c", name: id, subcircuit_connectivity_map_key: net },
    { type: "pcb_port", pcb_port_id: `p${id}`, source_port_id: `s${id}` },
    { type: "pcb_smtpad", pcb_smtpad_id: `pad${id}`, pcb_port_id: `p${id}`, layer, shape: "rect", x, y, width: 0.6, height: 0.6 },
  ]
  const wire = (id: string, portId: string, pts: [number, number][], layer = "top") => ({
    type: "pcb_trace",
    pcb_trace_id: id,
    route: pts.map(([x, y], i) => ({ route_type: "wire", x, y, width: 0.15, layer, ...(i === 0 ? { start_pcb_port_id: portId } : {}) })),
  })

  test("a trace that reaches both pads is connected; one that stops short is an open", async () => {
    const { connectivityCheck } = await import("../src/engine/clearance")
    const pads = [comp, ...pin("a", "n1", 0, 0), ...pin("b", "n1", 10, 0)]
    expect(connectivityCheck([...pads, wire("t", "pa", [[0, 0], [10, 0]])]).opens).toEqual([])
    const broken = connectivityCheck([...pads, wire("t", "pa", [[0, 0], [8, 0]])])
    expect(broken.netsChecked).toBe(1)
    expect(broken.opens.length).toBe(1)
    expect(broken.opens[0]!.isolatedPins).toEqual(["X.b"])
  })

  test("a via joins the two layers; without it the far pad is open", async () => {
    const { connectivityCheck } = await import("../src/engine/clearance")
    const pads = [comp, ...pin("a", "n1", 0, 0, "top"), ...pin("b", "n1", 10, 0, "bottom")]
    const top = wire("t1", "pa", [[0, 0], [5, 0]], "top")
    const bottom = wire("t2", "pb", [[10, 0], [5, 0]], "bottom")
    const via = { type: "pcb_via", pcb_via_id: "v", x: 5, y: 0, outer_diameter: 0.3, hole_diameter: 0.2, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "n1" }
    expect(connectivityCheck([...pads, top, bottom, via]).opens).toEqual([])
    expect(connectivityCheck([...pads, top, bottom]).opens.length).toBe(1)
  })

  test("a pour joins its own net on its layer only", async () => {
    const { connectivityCheck } = await import("../src/engine/clearance")
    const net = { type: "source_net", source_net_id: "sn", name: "GND", subcircuit_connectivity_map_key: "n1" }
    const pads = [comp, net, ...pin("a", "n1", 0, 0), ...pin("b", "n1", 10, 0)]
    const pour = (layer: string) => ({ type: "pcb_copper_pour", pcb_copper_pour_id: "cp", layer, source_net_id: "sn" })
    expect(connectivityCheck([...pads, pour("top")]).opens).toEqual([])
    expect(connectivityCheck([...pads, pour("bottom")]).opens.length).toBe(1)
  })
})

describe("review regressions", () => {
  test("place_component leaves a prop that contains '>' or '$' intact", async () => {
    const r = await call("create_project", {
      name: "placement braces",
      code: `export default () => (
  <board width="20mm" height="15mm">
    <capacitor name="C1" capacitance="100nF" footprint="0402" connections={{ pin1: ".U1 > .VCC", pin2: "net.GND" }} />
    <chip name="U1" footprint="soic8" pinLabels={{ pin1: "VCC", pin2: "$'" }} />
  </board>
)
`,
    })
    const project = r.result.project
    expect((await call("place_component", { project, name: "C1", x: 5, y: 3 })).ok).toBe(true)
    expect((await call("place_component", { project, name: "U1", x: -2 })).ok).toBe(true)
    const src = (await call("read_file", { project })).result.content as string
    expect(src).toContain('connections={{ pin1: ".U1 > .VCC", pin2: "net.GND" }} pcbX={5} pcbY={3} />')
    expect(src).toContain(`pinLabels={{ pin1: "VCC", pin2: "$'" }} pcbX={-2} />`)
    expect(src.split("\n").length).toBe(7)
  })

  test("project metadata, dotfiles and build configuration cannot be written through the tools", async () => {
    for (const p of ["aeda.json", "AEDA.json", "bunfig.toml", "package.json", "tsconfig.json", ".env", "node_modules/react/index.js"]) {
      const r = await call("write_file", { project, path: p, content: "null" })
      expect({ p, ok: r.ok, code: r.result?.error?.code }).toEqual({ p, ok: false, code: "bad_path" })
    }
    // ordinary design files still are
    expect((await call("write_file", { project, path: "lib/Part.tsx", content: "export const x = 1\n" })).ok).toBe(true)
    expect((await call("list_projects", {})).result.projects.some((x: any) => x.id === project)).toBe(true)
  })

  test("edit_file refuses an empty old_string", async () => {
    const r = await call("edit_file", { project, old_string: "", new_string: "x", replace_all: true })
    expect(r.ok).toBe(false)
    expect(r.result.error.code).toBe("edit_no_match")
  })

  test("the LED rule is not satisfied by a resistor that only sits on the supply or ground net", async () => {
    const { electricalRules } = await import("../src/engine/erc")
    const codes = electricalRules(
      [
        { name: "D1", kind: "led", pins: ["anode", "cathode"] },
        { name: "R1", kind: "resistor", pins: ["pin1", "pin2"] },
      ],
      [
        { name: "V5", pins: ["D1.anode", "R1.pin1"], isPower: true },
        { name: "GND", pins: ["D1.cathode", "R1.pin2"], isGround: true },
      ],
    ).map((d) => d.code)
    expect(codes).toContain("erc_led_no_resistor")
  })

  test("round pads are measured as circles, and a pad at 45 degrees still blocks along its length", async () => {
    const { clearanceCheck } = await import("../src/engine/clearance")
    const port = (id: string, net: string) => [
      { type: "source_port", source_port_id: `s${id}`, source_component_id: "c", name: id, subcircuit_connectivity_map_key: net },
      { type: "pcb_port", pcb_port_id: `p${id}`, source_port_id: `s${id}` },
    ]
    const base = [{ type: "source_component", source_component_id: "c", name: "X" }, ...port("a", "netA"), ...port("b", "netB")]
    const wire = (pts: [number, number][]) => ({ type: "pcb_trace", pcb_trace_id: "t", route: pts.map(([x, y], i) => ({ route_type: "wire", x, y, width: 0.2, layer: "top", ...(i === 0 ? { start_pcb_port_id: "pa" } : {}) })) })
    // circle of radius 1 at the origin; trace centre line at y = 1.25, 0.2 wide -> gap 0.15
    const circle = { type: "pcb_smtpad", pcb_smtpad_id: "p1", pcb_port_id: "pb", layer: "top", shape: "circle", x: 0, y: 0, radius: 1 }
    expect(clearanceCheck([...base, circle, wire([[-5, 1.25], [5, 1.25]])], 0.1).minGapMm).toBeCloseTo(0.15, 3)
    // 4 x 0.6 pad at 45 degrees: its far end is near (1.2, 1.2); a trace through there is a short
    const slanted = { type: "pcb_smtpad", pcb_smtpad_id: "p2", pcb_port_id: "pb", layer: "top", shape: "rect", x: 0, y: 0, width: 4, height: 0.6, ccw_rotation: 45 }
    const r = clearanceCheck([...base, slanted, wire([[1.2, -5], [1.2, 5]])], 0.1)
    expect(r.violations.length).toBe(1)
    expect(r.violations[0]!.gapMm).toBe(0)
  })
})
