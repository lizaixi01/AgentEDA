/**
 * Turns raw Circuit JSON into a compact, agent-readable design report:
 * summary numbers, netlist, BOM, and a normalised diagnostics list with fix hints.
 */
import { runAllChecks } from "@tscircuit/checks"
import { electricalRules } from "./erc"
import { clearanceCheck, connectivityCheck } from "./clearance"

export type Severity = "error" | "warning" | "info"

export interface Diagnostic {
  severity: Severity
  code: string
  message: string
  /** Designators involved, e.g. ["U1","R3"] */
  components?: string[]
  /** PCB location in mm, when the check provides one */
  at?: { x: number; y: number }
  /** What an agent should try next */
  hint?: string
}

export interface NetInfo {
  name: string
  pins: string[]
  /** Typical (length-weighted median) trace width on this net, mm; absent when nothing is routed */
  traceWidthMm?: number
  /** Share of this net's copper length narrower than 0.25 mm, 0..1 */
  thinFraction?: number
  isPower?: boolean
  isGround?: boolean
}

export interface BomLine {
  designators: string[]
  qty: number
  kind: string
  value: string
  footprint: string
  mpn?: string
  lcsc?: string
  /** true when the part has a JLCPCB/LCSC part number and can be assembled */
  sourced: boolean
  /** Filled by the catalogue lookup after analysis (absent offline) */
  unitPrice?: number | null
  stock?: number | null
  basic?: boolean
  partDescription?: string
}

export interface DesignReport {
  ok: boolean
  status: "pass" | "warnings" | "errors" | "compile_failed"
  summary: {
    board: { widthMm: number; heightMm: number; layers: number; thicknessMm: number } | null
    components: number
    nets: number
    pins: number
    traces: number
    vias: number
    traceLengthMm: number
    connectionsRouted: number
    connectionsTotal: number
    /** Share of the board area covered by part bodies, 0-100. Under ~15 the board can shrink; over ~45 routing gets hard */
    areaUsedPct?: number
    bomLines: number
    bomSourced: number
    /** Parts cost for one board in USD, from catalogue unit prices (null when unknown) */
    bomCostUsd?: number | null
    /** BOM lines that are JLCPCB "extended" parts (each adds a one-off assembly fee) */
    extendedParts?: number
    errors: number
    warnings: number
  }
  errors: Diagnostic[]
  warnings: Diagnostic[]
  info: Diagnostic[]
  components: {
    name: string
    kind: string
    value?: string
    footprint?: string
    mpn?: string
    lcsc?: string
    x?: number
    y?: number
    rotation?: number
    layer?: string
    /** Pad bounding box of the placed part, mm */
    widthMm?: number
    heightMm?: number
    pins: string[]
  }[]
  nets: NetInfo[]
  bom: BomLine[]
  /** Board minimums against the fab's capability table */
  dfm?: { fab: string; rules: DfmRule[] }
  /** SPICE results, present when the design contains <analogsimulation> and probes */
  simulation?: SimulationSummary
}

export interface ProbeStats {
  name: string
  experiment: string
  minV: number
  maxV: number
  meanV: number
  finalV: number
  peakToPeakV: number
  /** Estimated from mean crossings; null for DC-like signals */
  frequencyHz: number | null
  /** Fraction of time above the midpoint; null when not periodic */
  dutyCycle: number | null
  /** Same statistics over the second half of the run only, i.e. without the start-up transient */
  settled: { minV: number; maxV: number; meanV: number; peakToPeakV: number }
  /** Downsampled waveform for plotting: [time ms, volts][] */
  points: [number, number][]
}

export interface SimulationSummary {
  experiments: { name: string; durationMs: number }[]
  probes: ProbeStats[]
}

function summarizeSimulation(circuitJson: any[]): SimulationSummary | undefined {
  const graphs = circuitJson.filter((e) => e.type === "simulation_transient_voltage_graph")
  if (!graphs.length) return undefined
  const experiments = circuitJson.filter((e) => e.type === "simulation_experiment")
  const expName = (id: string) => experiments.find((e) => e.simulation_experiment_id === id)?.name ?? "simulation"
  const sig = (n: number) => Number(n.toPrecision(4))
  const probes: ProbeStats[] = graphs.map((g) => {
    const v: number[] = g.voltage_levels ?? []
    const t: number[] = g.timestamps_ms ?? v.map((_: number, i: number) => (g.start_time_ms ?? 0) + i * (g.time_per_step ?? 1))
    const min = Math.min(...v)
    const max = Math.max(...v)
    const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)
    const pp = max - min
    // Periodicity: rising crossings of the midpoint, with hysteresis so noise does not count.
    let frequencyHz: number | null = null
    let dutyCycle: number | null = null
    // Thresholds come from the settled half of the run, so a start-up swing from 0 V does not hide the oscillation.
    const late = v.slice(Math.floor(v.length / 2))
    const lateMin = Math.min(...late)
    const lateMax = Math.max(...late)
    const latePp = lateMax - lateMin
    if (latePp > Math.max(1e-3, Math.abs(mean) * 0.02) && v.length > 8) {
      const mid = (lateMax + lateMin) / 2
      const hi = mid + latePp * 0.1
      const lo = mid - latePp * 0.1
      const rises: number[] = []
      let state = v[0]! > mid
      for (let i = 1; i < v.length; i++) {
        if (!state && v[i]! > hi) {
          state = true
          rises.push(t[i]!)
        } else if (state && v[i]! < lo) state = false
      }
      if (rises.length >= 2) {
        const period = (rises[rises.length - 1]! - rises[0]!) / (rises.length - 1)
        if (period > 0) {
          frequencyHz = sig(1000 / period)
          // duty over whole periods only
          const from = rises[0]!
          const to = rises[rises.length - 1]!
          let above = 0
          let total = 0
          for (let i = 1; i < v.length; i++) {
            if (t[i]! <= from || t[i]! > to) continue
            const dt = t[i]! - t[i - 1]!
            total += dt
            if (v[i]! > mid) above += dt
          }
          dutyCycle = total > 0 ? sig(above / total) : null
        }
      }
    }
    const tail = v.slice(Math.floor(v.length / 2))
    const tMin = Math.min(...tail)
    const tMax = Math.max(...tail)
    const settled = {
      minV: sig(tMin),
      maxV: sig(tMax),
      meanV: sig(tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length)),
      peakToPeakV: sig(tMax - tMin),
    }
    const step = Math.max(1, Math.ceil(v.length / 600))
    const points: [number, number][] = []
    for (let i = 0; i < v.length; i += step) points.push([sig(t[i]!), sig(v[i]!)])
    if (v.length && (v.length - 1) % step !== 0) points.push([sig(t[v.length - 1]!), sig(v[v.length - 1]!)])
    return {
      name: g.source_probe_name ?? g.name,
      experiment: expName(g.simulation_experiment_id),
      minV: sig(min),
      maxV: sig(max),
      meanV: sig(mean),
      finalV: sig(v[v.length - 1] ?? 0),
      peakToPeakV: sig(pp),
      frequencyHz,
      dutyCycle,
      settled,
      points,
    }
  })
  return {
    experiments: experiments.map((e) => ({ name: e.name ?? "simulation", durationMs: e.end_time_ms ?? 0 })),
    probes,
  }
}

/** Diagnostics that are pure style nags: reported as info, never block a build. */
const INFO_CODES = new Set([
  "source_unnamed_trace_warning",
  "schematic_missing_sheet_warning",
  "source_missing_manufacturer_part_number_warning",
  "source_component_pins_underspecified_warning",
  "source_no_power_pin_defined_warning",
  "source_no_ground_pin_defined_warning",
  "pcb_components_missing_courtyard_warning",
  "schematic_component_styling_warning",
  "pcb_trace_style_warning",
  "source_refdes_convention_warning",
  "supplier_footprint_mismatch_warning",
])

/** Schematic-styling and naming nags with no bearing on the board; never reported. */
const STYLE_NOISE = new Set(["source_unnamed_trace_warning", "schematic_missing_sheet_warning", "schematic_component_styling_warning"])

/** Errors that are only symptoms of "copper was not routed"; folded into one diagnostic. */
const UNROUTED_CODES = new Set(["pcb_port_not_connected_error", "pcb_trace_missing_error"])

const HINTS: [RegExp, string][] = [
  [
    /routeRemaining|over \d+ traces remaining/i,
    "Not a space problem: boards with more than 50 connections need routing switched on explicitly. Add the routeRemaining prop to the board, e.g. <board width=\"58mm\" height=\"32mm\" routeRemaining>, and rebuild.",
  ],
  [
    /exceeding the \d+ maximum|uses \d+ vias?/i,
    "A length- or via-limited net (crystal pins get max 0 vias and 10 mm automatically) was routed with a detour. Put the crystal and its load capacitors directly beside the oscillator pins, on the same layer, so the trace is short and needs no via.",
  ],
  [
    /could not find port|has no ports|does not have pin|selector/i,
    "A trace points at a pin that does not exist. Check the part name and pin name (see components[].pins in the detail report). If the part itself failed to be created, fix that error first.",
  ],
  [
    /expected .* received|invalid enum|invalid_type|failed_to_create/i,
    "A prop has a value the element does not accept. The message lists the allowed values or type; change the prop and rebuild.",
  ],
  [
    /connector_not_in_accessible_orientation/i,
    "Turn the connector so its opening faces the nearest board edge: change pcbRotation (try 90, -90 or 180). You do not need to edit the footprint.",
  ],
  [/part_not_found/i, "That supplier number has no usable footprint in the catalogue. Pick another part with search_parts, or drop supplierPartNumbers and let the passive be matched automatically."],
  [
    /autorouting was skipped|placement error/i,
    "Routing did not run because of the placement errors listed with it. Fix those (each says how far to move the part); routing runs on the next build.",
  ],
  [
    /outside_board|outside board/i,
    "Move the part inward by the stated distance, or enlarge the board. If the part is meant to overhang the edge (USB socket lip, side-actuated switch lever), add allowOffBoard to that part instead.",
  ],
  [
    /autorout/i,
    "Autorouter could not finish. Give it more room: enlarge the <board>, spread parts apart (pcbX/pcbY), move tightly coupled parts next to each other, or reduce crossing nets.",
  ],
  [
    /port_not_connected|not_connected|dangling/i,
    "A pin that is in the netlist has no copper reaching it. Usually an autorouting failure; rebuild after loosening placement.",
  ],
  [
    /overlap|courtyard/i,
    "Components overlap. Set explicit pcbX/pcbY (mm, board centre is 0,0) or enlarge the board so the packer has space.",
  ],
  [/out_of_board|outside|board_edge|edge_clearance/i, "Something sits outside or too close to the board edge. Move it inward or enlarge the board."],
  [/clearance|spacing|trace_error|accidental|short/i, "Copper clearance violation. Move the listed parts apart or re-route by changing placement; do not ignore, the fab will reject it."],
  [
    /footprint_mismatch/i,
    "The footprint you chose differs slightly from the supplier's land pattern. Fine for generic passives; for ICs import the exact part with `import_part` instead.",
  ],
  [
    /misconfigured|polarity/i,
    "The generic footprint's pin 1 is the opposite end from the supplier part's pin 1, so the part would be assembled reversed. For LEDs and diodes, import_part the exact LCSC part and use that component (its anode/cathode are correct), or use a known-matching generic: red 0603 C2286, white 0603 C2290.",
  ],
  [/failed_to_create|footprint.*not found|unknown footprint|Invalid footprint/i, "Unknown footprint string. Use a standard one (0402, 0603, soic8, sot23, qfn32, pinrow4 ...) or import the real part with `import_part`."],
  [/port.*not found|Could not find port|selector/i, "A trace selector does not match any pin. Selectors look like `.U1 > .VCC` or `.R1 > .pin1`; check `components[].pins` in the report for valid pin names."],
  [/pin_must_be_connected|must be connected|floating/i, "A pin that requires a connection is left floating. Wire it to a net (or mark it no-connect)."],
]

function hintFor(code: string, message: string): string | undefined {
  const text = `${code} ${message}`
  for (const [re, hint] of HINTS) if (re.test(text)) return hint
  return undefined
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d

export async function analyzeCircuitJson(circuitJson: any[]): Promise<DesignReport> {
  const byType = (t: string) => circuitJson.filter((e) => e.type === t)
  // Sources and probes exist only for simulation; they are not parts on the board.
  const SIM_ONLY = /voltage_source|current_source|voltage_probe|ammeter|simulation/
  const srcComponents = byType("source_component").filter((c) => !SIM_ONLY.test(String(c.ftype ?? "")))
  const pcbComponents = byType("pcb_component")
  const simOnlyIds = new Set(
    byType("source_component")
      .filter((c) => SIM_ONLY.test(String(c.ftype ?? "")))
      .map((c) => c.source_component_id),
  )
  const srcPorts = byType("source_port").filter((p) => !simOnlyIds.has(p.source_component_id))
  const srcNets = byType("source_net")
  const pcbTraces = byType("pcb_trace")
  const pcbVias = byType("pcb_via")
  const pcbPorts = byType("pcb_port")
  const cadComponents = byType("cad_component")
  const board = byType("pcb_board")[0]

  const srcById = new Map(srcComponents.map((c) => [c.source_component_id, c]))
  const pcbById = new Map(pcbComponents.map((c) => [c.pcb_component_id, c]))
  const pcbBySrc = new Map(pcbComponents.map((c) => [c.source_component_id, c]))
  const portById = new Map(srcPorts.map((p) => [p.source_port_id, p]))
  const pcbPortById = new Map(pcbPorts.map((p) => [p.pcb_port_id, p]))
  const cadBySrc = new Map(cadComponents.map((c) => [c.source_component_id, c]))

  /** Human pin label: the datasheet-style alias when there is one (VBUS1), else pinN. */
  const pinLabel = (p: any): string => {
    const ftype = String(srcById.get(p.source_component_id)?.ftype ?? "")
    // Non-polar two-terminal parts carry meaningless aliases (anode/pos/left); keep pin1/pin2.
    if (/resistor|capacitor|inductor|crystal|fuse|push_button|switch|resonator|potentiometer/.test(ftype)) return p.name
    const hints: string[] = (p.port_hints ?? []).filter((h: string) => !/^(left|right|top|bottom)$/.test(h))
    for (const preferred of ["anode", "cathode"]) if (hints.includes(preferred)) return preferred
    return hints.find((h) => !/^pin\d+/i.test(h) && !/^\d+$/.test(h)) ?? p.name
  }
  const pinName = (p: any) => {
    const comp = srcById.get(p.source_component_id)
    return `${comp?.name ?? "?"}.${pinLabel(p)}`
  }

  /** Area the parts claim: each part's courtyard when it has one, else its pad bounding box. */
  const footprintArea = () => {
    const byComp = new Map<string, number>()
    for (const r of byType("pcb_courtyard_rect"))
      byComp.set(r.pcb_component_id, Math.max(byComp.get(r.pcb_component_id) ?? 0, (Number(r.width) || 0) * (Number(r.height) || 0)))
    for (const o of byType("pcb_courtyard_outline")) {
      const pts: { x: number; y: number }[] = o.outline ?? []
      if (pts.length < 3) continue
      const xs = pts.map((p) => p.x)
      const ys = pts.map((p) => p.y)
      const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
      byComp.set(o.pcb_component_id, Math.max(byComp.get(o.pcb_component_id) ?? 0, area))
    }
    let total = 0
    for (const c of pcbComponents) total += byComp.get(c.pcb_component_id) ?? (Number(c.width) || 0) * (Number(c.height) || 0)
    return total
  }

  // ---- components -------------------------------------------------------
  const components = srcComponents.map((c) => {
    const pcb = pcbBySrc.get(c.source_component_id)
    const cad = cadBySrc.get(c.source_component_id)
    const lcsc = c.supplier_part_numbers?.jlcpcb?.[0]
    const value =
      c.display_resistance ??
      c.display_capacitance ??
      c.display_inductance ??
      c.display_value ??
      c.display_name ??
      (c.ftype === "simple_led" && c.color ? `${c.color} LED` : undefined) ??
      (c.frequency ? `${c.frequency / 1e6} MHz` : undefined)
    return {
      name: c.name as string,
      kind: String(c.ftype ?? "component").replace(/^simple_/, ""),
      value,
      footprint: cad?.footprinter_string ?? undefined,
      mpn: c.manufacturer_part_number ?? undefined,
      lcsc,
      // The footprint origin is what pcbX / pcbY set; the body centre can differ for asymmetric parts.
      x: pcb ? round((pcb.footprint_origin ?? pcb.center).x) : undefined,
      y: pcb ? round((pcb.footprint_origin ?? pcb.center).y) : undefined,
      ...(pcb ? { widthMm: round(Number(pcb.width) || 0, 2), heightMm: round(Number(pcb.height) || 0, 2) } : {}),
      rotation: pcb ? round(Number(pcb.rotation) || 0, 1) : undefined,
      layer: pcb?.layer,
      pins: [
        ...new Set(
          srcPorts
            .filter((p) => p.source_component_id === c.source_component_id && !/_internal_/.test(p.name))
            .map(pinLabel),
        ),
      ],
    }
  })

  // ---- nets -------------------------------------------------------------
  const netGroups = new Map<string, any[]>()
  for (const p of srcPorts) {
    const key = p.subcircuit_connectivity_map_key
    if (!key) continue
    if (!netGroups.has(key)) netGroups.set(key, [])
    netGroups.get(key)!.push(p)
  }
  let anon = 1
  const nets: NetInfo[] = []
  const netByKey = new Map<string, NetInfo>()
  for (const [key, ports] of netGroups) {
    const named = srcNets.find((n) => n.subcircuit_connectivity_map_key === key)
    const info: NetInfo = {
      name: named?.name ?? `N${anon++}`,
      pins: ports.map(pinName).sort(),
      ...(named?.is_power ? { isPower: true } : {}),
      ...(named?.is_ground ? { isGround: true } : {}),
    }
    nets.push(info)
    netByKey.set(key, info)
  }
  nets.sort((a, b) => b.pins.length - a.pins.length)

  // ---- routing completeness --------------------------------------------
  // A net with n pins needs n-1 connections. A pin counts as reached when some
  // trace endpoint lands on it.
  const netSegments = new Map<NetInfo, [number, number][]>()
  const reached = new Set<string>()
  let traceLength = 0
  for (const t of pcbTraces) {
    const route = t.route ?? []
    for (let i = 0; i < route.length; i++) {
      const pt = route[i]
      for (const k of ["start_pcb_port_id", "end_pcb_port_id"]) {
        const sp = pcbPortById.get(pt[k])?.source_port_id
        if (sp) reached.add(sp)
      }
      if (i > 0 && pt.route_type === "wire" && route[i - 1].route_type === "wire")
        traceLength += Math.hypot(pt.x - route[i - 1].x, pt.y - route[i - 1].y)
    }
    // Narrowest segment per net
    const anyPort = route.map((pt: any) => pcbPortById.get(pt.start_pcb_port_id ?? pt.end_pcb_port_id)).find(Boolean)
    const net = netByKey.get(portById.get(anyPort?.source_port_id)?.subcircuit_connectivity_map_key)
    if (net) {
      const segs = netSegments.get(net) ?? []
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1]
        const b = route[i]
        if (a.route_type !== "wire" || b.route_type !== "wire" || typeof b.width !== "number") continue
        segs.push([Math.min(a.width ?? b.width, b.width), Math.hypot(b.x - a.x, b.y - a.y)])
      }
      netSegments.set(net, segs)
    }
  }
  // Typical width per net = the width that half of the net's copper length is at least as wide as.
  // (The router necks traces down for a short stretch at fine-pitch pads; the minimum would mislead.)
  for (const [net, segs] of netSegments) {
    const total = segs.reduce((n, [, len]) => n + len, 0)
    if (total <= 0) continue
    segs.sort((x, y) => x[0] - y[0])
    net.thinFraction = Math.round((segs.filter(([w]) => w < 0.25).reduce((n, [, len]) => n + len, 0) / total) * 100) / 100
    let acc = 0
    for (const [w, len] of segs) {
      acc += len
      if (acc >= total / 2) {
        net.traceWidthMm = round(w)
        break
      }
    }
  }
  let connectionsTotal = 0
  let connectionsRouted = 0
  const unroutedPins: string[] = []
  for (const ports of netGroups.values()) {
    if (ports.length < 2) continue
    connectionsTotal += ports.length - 1
    const hit = ports.filter((p) => reached.has(p.source_port_id))
    connectionsRouted += Math.max(0, hit.length - 1)
    if (hit.length < ports.length) for (const p of ports) if (!reached.has(p.source_port_id)) unroutedPins.push(pinName(p))
  }

  // ---- diagnostics ------------------------------------------------------
  const raw: any[] = circuitJson.filter((e) => /(_error|_warning)$/.test(e.type) || e.error_type || e.warning_type)
  try {
    const extra = await runAllChecks(circuitJson as any)
    for (const e of extra as any[]) raw.push(e)
  } catch (e: any) {
    raw.push({ type: "check_runner_warning", message: `DRC runner crashed: ${e?.message ?? e}` })
  }

  const seen = new Set<string>()
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []
  const info: Diagnostic[] = []
  for (const e of raw) {
    const code = String(e.error_type ?? e.warning_type ?? e.type)
    // Some upstream errors append a dump of internal objects; keep the sentence, drop the dump.
    let message = String(e.message ?? code)
    const dumpAt = message.search(/\s*(?:\{\s*"?\$\$typeof|\[object Object\]|\n\s*at\s)/)
    if (dumpAt > 40) message = message.slice(0, dumpAt)
    if (message.length > 600) message = message.slice(0, 600) + " ..."
    const key = `${code}|${message}`
    if (seen.has(key)) continue
    seen.add(key)
    const names = new Set<string>()
    const addSrc = (id: any) => {
      const n = srcById.get(id)?.name
      if (n) names.add(n)
    }
    const addPcb = (id: any) => addSrc(pcbById.get(id)?.source_component_id)
    if (e.source_component_id) addSrc(e.source_component_id)
    for (const id of e.source_component_ids ?? []) addSrc(id)
    if (e.pcb_component_id) addPcb(e.pcb_component_id)
    for (const id of e.pcb_component_ids ?? []) addPcb(id)
    for (const id of e.pcb_port_ids ?? []) addPcb(pcbPortById.get(id)?.pcb_component_id)
    for (const id of e.source_port_ids ?? []) addSrc(portById.get(id)?.source_component_id)
    const d: Diagnostic = {
      severity: "error",
      code,
      message,
      ...(names.size ? { components: [...names] } : {}),
      ...(e.center && typeof e.center.x === "number" ? { at: { x: round(e.center.x), y: round(e.center.y) } } : {}),
    }
    const hint = hintFor(code, message)
    if (hint) d.hint = hint
    if (e.source_component_id && simOnlyIds.has(e.source_component_id) && /warning/.test(code)) continue
    if (STYLE_NOISE.has(code)) continue
    // Under half of the copper overlapping the supplier's real pads is the wrong package, whatever the part.
    const iou = Number(e.footprint_copper_intersection_over_union ?? String(e.message ?? "").match(/IoU ([\d.]+)/)?.[1] ?? NaN)
    if (code === "supplier_footprint_mismatch_warning" && Number.isFinite(iou) && iou < 0.5) {
      d.code = "supplier_footprint_wrong_package"
      d.hint =
        "The footprint drawn here overlaps less than half of the supplier part's real pads, so that part will not solder onto it. Use the footprint that matches the part (import_part gives the exact one) or choose a part that comes in this package."
      errors.push(d)
    } else if (INFO_CODES.has(code)) {
      d.severity = "info"
      info.push(d)
    } else if (/warning/.test(code)) {
      d.severity = "warning"
      warnings.push(d)
    } else {
      errors.push(d)
    }
  }
  const mismatches = info.filter((d) => d.code === "supplier_footprint_mismatch_warning")
  if (mismatches.length > 1) {
    for (const m of mismatches) info.splice(info.indexOf(m), 1)
    info.push({
      severity: "info",
      code: "supplier_footprint_mismatch_warning",
      message: `${mismatches.length} part(s) use a land pattern slightly different from the supplier's recommended one (most of the copper still overlaps): ${[...new Set(mismatches.flatMap((m) => m.components ?? []))].join(", ")}.`,
      components: [...new Set(mismatches.flatMap((m) => m.components ?? []))],
      hint: mismatches[0]!.hint,
    })
  }

  // Fold the per-pin "not connected" cascade into one line so the root cause stays visible.
  const symptoms = errors.filter((e) => UNROUTED_CODES.has(e.code))
  if (symptoms.length) {
    // Only an error that can actually stop routing is named as the cause.
    const rootCause = errors.find(
      (e) => !UNROUTED_CODES.has(e.code) && /autorout|placement|failed_to_create|missing_footprint|outside_board|overlap/i.test(e.code),
    )
    for (const sy of symptoms) errors.splice(errors.indexOf(sy), 1)
    errors.push({
      severity: "error",
      code: "unrouted_connections",
      message:
        `${connectionsTotal - connectionsRouted} of ${connectionsTotal} connections have no copper` +
        (unroutedPins.length ? ` (pins: ${unroutedPins.slice(0, 14).join(", ")}${unroutedPins.length > 14 ? ", ..." : ""})` : "") +
        (rootCause ? `. This follows from the error above (${rootCause.code}); fix that first.` : "."),
      hint: rootCause ? undefined : hintFor("autorouting", ""),
    })
  }
  // One line per component for unconnected pins instead of one per pin.
  const floating = warnings.filter((w) => w.code === "source_pin_missing_trace_warning")
  if (floating.length) {
    const byComp = new Map<string, string[]>()
    for (const w of floating) {
      warnings.splice(warnings.indexOf(w), 1)
      const m = w.message.match(/^Port (\S+) on (\S+)/)
      const comp = m?.[2] ?? w.components?.[0] ?? "?"
      if (m && /_internal_/.test(m[1]!)) continue
      const src = srcComponents.find((c) => c.name === comp)
      const port = srcPorts.find((p) => p.source_component_id === src?.source_component_id && p.name === m?.[1])
      if (!byComp.has(comp)) byComp.set(comp, [])
      byComp.get(comp)!.push(port ? pinLabel(port) : (m?.[1] ?? "?"))
    }
    for (const [comp, pins] of byComp)
      if (pins.length)
        warnings.push({
          severity: "warning",
          code: "unconnected_pins",
          message: `${comp} has ${pins.length} unconnected pin(s): ${pins.join(", ")}`,
          components: [comp],
          hint: "Fine if intentional (unused GPIO, spare connector pins). Otherwise wire them; power, ground, enable and reset pins must never float.",
        })
  }
  if (unroutedPins.length && !errors.some((e) => /autorout|unrouted/.test(e.code))) {
    errors.push({
      severity: "error",
      code: "unrouted_connections",
      message: `${connectionsTotal - connectionsRouted} connection(s) have no copper: ${unroutedPins.slice(0, 12).join(", ")}`,
      hint:
        (simOnlyIds.size > 0 && connectionsRouted === 0
          ? 'Nothing routed at all and the design has a simulation source: connect <voltagesource> pins to named nets (to="net.V5"), never directly to a part\'s pin. Otherwise: '
          : "") + hintFor("autorouting", ""),
    })
  }
  // A value that failed to parse renders as NaN and would silently ship a wrong part.
  for (const c of srcComponents) {
    for (const key of ["resistance", "capacitance", "inductance", "frequency"]) {
      const display = String(c[`display_${key}`] ?? "")
      if (key in c && ((typeof c[key] === "number" && Number.isNaN(c[key])) || /NaN/.test(display)))
        errors.unshift({
          severity: "error",
          code: "invalid_value",
          message: `${c.name} has an unparseable ${key}. Write it like ${key === "resistance" ? '"10k" or "4.7k"' : key === "capacitance" ? '"100nF" or "10uF"' : key === "inductance" ? '"10uH"' : '"16MHz"'}.`,
          components: [c.name],
        })
    }
  }
  if (!board) {
    errors.push({
      severity: "error",
      code: "no_board",
      message: "Design has no <board>. Wrap everything in <board width=\"..mm\" height=\"..mm\">.",
    })
  }

  // ---- BOM --------------------------------------------------------------
  const bomMap = new Map<string, BomLine>()
  for (const c of components) {
    const key = [c.kind, c.value ?? "", c.footprint ?? "", c.mpn ?? "", c.lcsc ?? ""].join("|")
    const line = bomMap.get(key)
    if (line) {
      line.designators.push(c.name)
      line.qty++
    } else {
      bomMap.set(key, {
        designators: [c.name],
        qty: 1,
        kind: c.kind,
        value: c.value ?? c.mpn ?? "",
        footprint: c.footprint ?? "",
        mpn: c.mpn,
        lcsc: c.lcsc,
        sourced: Boolean(c.lcsc),
      })
    }
  }
  const bom = [...bomMap.values()]
  for (const line of bom) {
    if (!line.sourced)
      warnings.push({
        severity: "warning",
        code: "bom_part_not_sourced",
        message: `${line.designators.join(", ")} (${line.value || line.kind}, ${line.footprint || "no footprint"}) has no LCSC part number, so JLCPCB cannot assemble it.`,
        components: line.designators,
        hint: "Find one with `search_parts`, then either set supplierPartNumbers={{ jlcpcb: [\"C12345\"] }} or import the exact part with `import_part`. Through-hole headers you solder yourself can be left unsourced.",
      })
  }

  // ---- silkscreen legibility (advisory) --------------------------------------
  // Designators printed over another part's pads or over each other cannot be read on the board.
  {
    type Box = { x1: number; y1: number; x2: number; y2: number; layer: string; owner: string; label: string }
    const nameOfPcb = (id: any) => srcById.get(pcbById.get(id)?.source_component_id)?.name ?? "?"
    const texts: Box[] = byType("pcb_silkscreen_text")
      .filter((t) => t.anchor_position && t.text && pcbById.has(t.pcb_component_id))
      .map((t) => {
        const fs = Number(t.font_size) || 1
        // Rendered glyphs are a little larger than the nominal size; err towards reporting.
        let w = String(t.text).length * fs * 0.7
        let h = fs * 1.3
        if (Math.abs((Number(t.ccw_rotation) || 0) % 180) === 90) [w, h] = [h, w]
        const { x, y } = t.anchor_position
        return { x1: x - w / 2, x2: x + w / 2, y1: y - h / 2, y2: y + h / 2, layer: t.layer ?? "top", owner: nameOfPcb(t.pcb_component_id), label: String(t.text) }
      })
    const pads: Box[] = byType("pcb_smtpad")
      .filter((p) => typeof p.x === "number" && p.width)
      .map((p) => ({ x1: p.x - p.width / 2, x2: p.x + p.width / 2, y1: p.y - p.height / 2, y2: p.y + p.height / 2, layer: p.layer ?? "top", owner: nameOfPcb(p.pcb_component_id), label: "" }))
    const hit = (a: Box, b: Box) => a.layer === b.layer && a.x1 < b.x2 - 0.05 && a.x2 > b.x1 + 0.05 && a.y1 < b.y2 - 0.05 && a.y2 > b.y1 + 0.05
    const clashes = new Set<string>()
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i]!
      if (t.label !== t.owner) continue // only designators; pin labels sit on purpose next to pads
      for (const p of pads) if (p.owner !== t.owner && hit(t, p)) clashes.add(`${t.owner} label over ${p.owner}'s pad`)
      for (let j = i + 1; j < texts.length; j++) {
        const u = texts[j]!
        if (u.label === u.owner && u.owner !== t.owner && hit(t, u)) clashes.add(`${t.owner} and ${u.owner} labels overlap`)
      }
    }
    if (clashes.size)
      info.push({
        severity: "info",
        code: "silkscreen_overlap",
        message: `Silkscreen designators are obscured: ${[...clashes].slice(0, 8).join("; ")}${clashes.size > 8 ? `; and ${clashes.size - 8} more` : ""}.`,
        hint: "Cosmetic, but the board is harder to assemble and debug. Leave more room between the parts involved, or rotate one of them.",
      })
  }

  // ---- electrical rules on the netlist -------------------------------------
  for (const d of electricalRules(components, nets)) (d.severity === "error" ? errors : warnings).push(d)

  // Supply rails on hairline traces: legal for the fab, wrong for the current.
  // Only names that are unmistakably rails; "VDIV", "VOUT_ADC" and the like are signals.
  const RAIL = /^(VCC|VDD|VBUS|VBAT|VIN|VM|VSYS|VSUP|V\d[\dV_]*|\d+V\d*|P\d+V\d*)$/i
  // More than a short neck at a fine-pitch pin: a real stretch of the rail is at signal width.
  const thinPower = nets.filter((n) => RAIL.test(n.name) && !n.isGround && (n.thinFraction ?? 0) > 0.3)
  // Advisory only: whether it matters depends on the current, which the netlist does not know.
  if (thinPower.length)
    info.push({
      severity: "info",
      code: "power_trace_thin",
      message: `Power net(s) ${thinPower.map((n) => `${n.name} (${Math.round((n.thinFraction ?? 0) * 100)}% of its length under 0.25 mm)`).join(", ")} are partly routed at signal width.`,
      hint: 'Fine below about 0.3 A. For more, widen the supply traces: add thickness="0.5mm" to every <trace> that ends on that net (about 0.4 mm per amp on 1 oz outer copper is a safe starting point).',
    })

  // Waveforms from a run whose source was never created are all zeros; do not present them as results.
  const sourceBroken = errors.some((e) => /failed_to_create/.test(e.code) && /voltagesource|currentsource/i.test(e.message))
  const simulation = sourceBroken ? undefined : summarizeSimulation(circuitJson)

  // ---- DFM ------------------------------------------------------------
  const dfmRules = dfmCheck(circuitJson)
  // Second opinion on spacing, computed from geometry independently of the router's own DRC.
  const spacing = clearanceCheck(circuitJson, JLCPCB_2L.minCopperSpacing)
  dfmRules.splice(1, 0, {
    id: "copper_spacing",
    label: "Copper spacing between nets",
    measured: spacing.minGapMm,
    limit: JLCPCB_2L.minCopperSpacing,
    status: spacing.minGapMm === null ? "n/a" : spacing.violations.length ? "fail" : "pass",
    blocking: spacing.violations.length > 0,
    count: spacing.pairsChecked,
  })
  // Layout versus netlist: every pin of a net must be joined by actual copper.
  if (pcbTraces.length > 0)
    for (const o of connectivityCheck(circuitJson).opens.slice(0, 10))
      errors.push({
        severity: "error",
        code: "layout_open",
        message: `Net ${o.net} is split into ${o.groups} pieces of copper; not joined to the rest: ${o.isolatedPins.slice(0, 12).join(", ")}.`,
        hint: "Found by the independent geometry check: the copper does not actually connect these pins. Rebuild after moving the parts closer or giving the router more room.",
      })
  for (const v of spacing.violations.slice(0, 10))
    errors.push({
      severity: "error",
      code: v.gapMm <= 0.001 ? "short_circuit" : "copper_spacing",
      message:
        v.gapMm <= 0.001
          ? `Copper of different nets touches on the ${v.layer} layer: ${v.a} and ${v.b}, near (${v.at.x}, ${v.at.y}) mm.`
          : `Only ${v.gapMm} mm between ${v.a} and ${v.b} on the ${v.layer} layer near (${v.at.x}, ${v.at.y}) mm; the fab needs ${JLCPCB_2L.minCopperSpacing} mm.`,
      at: v.at,
      hint: "Found by the independent geometry check. Move the parts around that point apart by a millimetre or so and rebuild; routing is redone. If it persists, rotate one of the parts so its pads do not face the other.",
    })
  for (const r of dfmRules) {
    if (r.status !== "fail" && !(r.status === "marginal" && r.measured !== null && r.measured < r.limit)) continue
    if (r.id === "copper_spacing") continue // reported above with locations
    const d: Diagnostic = {
      severity: r.blocking ? "error" : "info",
      code: `dfm_${r.id}`,
      message: `${r.label} is ${r.measured} mm; ${JLCPCB_2L.name} needs at least ${r.limit} mm.`,
      hint: r.blocking
        ? "Raise it on the <board> (e.g. minTraceWidth, pcbStyle={{ viaHoleDiameter, viaPadDiameter }}) or choose a part with larger holes."
        : "Cosmetic: the fab thickens or drops silkscreen that is too fine. Text may be hard to read.",
    }
    ;(r.blocking ? errors : info).push(d)
  }

  const status = errors.length ? "errors" : warnings.length ? "warnings" : "pass"
  return {
    ok: errors.length === 0,
    status,
    summary: {
      board: board
        ? {
            widthMm: round(board.width ?? 0),
            heightMm: round(board.height ?? 0),
            layers: board.num_layers ?? 2,
            thicknessMm: board.thickness ?? 1.6,
          }
        : null,
      components: components.length,
      nets: nets.filter((n) => n.pins.length > 1).length,
      pins: srcPorts.length,
      traces: pcbTraces.length,
      vias: pcbVias.length,
      traceLengthMm: round(traceLength, 1),
      ...(board && board.width && board.height
        ? {
            areaUsedPct: Math.round((footprintArea() / (board.width * board.height)) * 100),
          }
        : {}),
      connectionsRouted,
      connectionsTotal,
      bomLines: bom.length,
      bomSourced: bom.filter((b) => b.sourced).length,
      errors: errors.length,
      warnings: warnings.length,
    },
    errors,
    warnings,
    info,
    components,
    nets,
    bom,
    dfm: { fab: JLCPCB_2L.name, rules: dfmRules },
    ...(simulation ? { simulation } : {}),
  }
}

// ---- DFM: measured board minimums vs. fab capability --------------------------

export interface DfmRule {
  id: string
  label: string
  /** Smallest (or relevant) value found on the board, mm; null when the board has none of that feature */
  measured: number | null
  /** Fab limit, mm */
  limit: number
  /** Value the fab recommends staying above, mm */
  preferred?: number
  status: "pass" | "marginal" | "fail" | "n/a"
  /** Whether a failure blocks manufacturing (false = cosmetic, the fab adjusts it) */
  blocking: boolean
  count: number
}

/**
 * JLCPCB standard FR-4, 1-2 layers, 1 oz copper.
 * Source: https://jlcpcb.com/capabilities/pcb-capabilities (read 2026-11-22). Re-check before relying on a limit.
 */
export const JLCPCB_2L = {
  name: "JLCPCB FR-4 1-2 layer, 1 oz",
  minTraceWidth: 0.1,
  minViaHole: 0.15,
  preferredViaHole: 0.2,
  minViaPad: 0.25,
  minViaAnnular: 0.05,
  minPlatedHole: 0.15,
  minPthAnnular: 0.18,
  preferredPthAnnular: 0.25,
  minNpth: 0.5,
  minCopperSpacing: 0.1,
  minSilkWidth: 0.15,
  minSilkTextHeight: 1.0,
}

export function dfmCheck(circuitJson: any[], cap = JLCPCB_2L): DfmRule[] {
  const of = (t: string) => circuitJson.filter((e) => e.type === t)
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null)
  const r3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000)
  const rule = (id: string, label: string, values: number[], limit: number, blocking: boolean, preferred?: number): DfmRule => {
    const measured = r3(min(values))
    const eps = 1e-6
    // Cosmetic rules (silkscreen) never "fail": the fab adjusts them. They show as marginal.
    const below = measured !== null && measured + eps < limit
    const status = measured === null ? "n/a" : below ? (blocking ? "fail" : "marginal") : preferred !== undefined && measured + eps < preferred ? "marginal" : "pass"
    // "blocking" means: this rule is failing AND the fab cannot build it. Marginal and cosmetic results never block.
    return { id, label, measured, limit, preferred, status, blocking: blocking && status === "fail", count: values.length }
  }

  const traceWidths: number[] = []
  for (const t of of("pcb_trace")) for (const p of t.route ?? []) if (p.route_type === "wire" && typeof p.width === "number") traceWidths.push(p.width)

  const vias = of("pcb_via")
  const plated = of("pcb_plated_hole")
  const holeSize = (h: any) => h.hole_diameter ?? Math.min(h.hole_width ?? Infinity, h.hole_height ?? Infinity)
  const padSize = (h: any) =>
    h.outer_diameter ?? Math.min(h.outer_width ?? h.rect_pad_width ?? Infinity, h.outer_height ?? h.rect_pad_height ?? Infinity)
  const pthAnnular = plated.map((h) => (padSize(h) - holeSize(h)) / 2).filter((n) => Number.isFinite(n))

  return [
    rule("trace_width", "Trace width", traceWidths, cap.minTraceWidth, true),
    rule("via_hole", "Via drill", vias.map((v) => v.hole_diameter).filter(Number.isFinite), cap.minViaHole, true, cap.preferredViaHole),
    rule("via_pad", "Via pad diameter", vias.map((v) => v.outer_diameter).filter(Number.isFinite), cap.minViaPad, true),
    rule("via_annular", "Via annular ring", vias.map((v) => (v.outer_diameter - v.hole_diameter) / 2).filter(Number.isFinite), cap.minViaAnnular, true),
    rule("plated_hole", "Plated hole drill", plated.map(holeSize).filter(Number.isFinite), cap.minPlatedHole, true),
    rule("pth_annular", "Plated hole annular ring", pthAnnular, cap.minPthAnnular, true, cap.preferredPthAnnular),
    rule("npth", "Non-plated hole", of("pcb_hole").map(holeSize).filter(Number.isFinite), cap.minNpth, true),
    rule("silk_width", "Silkscreen line width", of("pcb_silkscreen_path").map((s) => s.stroke_width).filter(Number.isFinite), cap.minSilkWidth, false),
    rule("silk_text", "Silkscreen text height", of("pcb_silkscreen_text").map((s) => s.font_size).filter(Number.isFinite), cap.minSilkTextHeight, false),
  ]
}
