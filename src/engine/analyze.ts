/**
 * Turns raw Circuit JSON into a compact, agent-readable design report:
 * summary numbers, netlist, BOM, and a normalised diagnostics list with fix hints.
 */
import { runAllChecks } from "@tscircuit/checks"

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
    bomLines: number
    bomSourced: number
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
    pins: string[]
  }[]
  nets: NetInfo[]
  bom: BomLine[]
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
  "supplier_footprint_mismatch_warning",
])

/** Errors that are only symptoms of "copper was not routed"; folded into one diagnostic. */
const UNROUTED_CODES = new Set(["pcb_port_not_connected_error", "pcb_trace_missing_error"])

const HINTS: [RegExp, string][] = [
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
    "Pin mapping disagrees with the supplier part. Fix pinLabels or pick a different supplier part via supplierPartNumbers.",
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
  const srcComponents = byType("source_component")
  const pcbComponents = byType("pcb_component")
  const srcPorts = byType("source_port")
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
    const hints: string[] = p.port_hints ?? []
    return hints.find((h) => !/^pin\d+/i.test(h) && !/^\d+$/.test(h)) ?? p.name
  }
  const pinName = (p: any) => {
    const comp = srcById.get(p.source_component_id)
    return `${comp?.name ?? "?"}.${pinLabel(p)}`
  }

  // ---- components -------------------------------------------------------
  const components = srcComponents.map((c) => {
    const pcb = pcbBySrc.get(c.source_component_id)
    const cad = cadBySrc.get(c.source_component_id)
    const lcsc = c.supplier_part_numbers?.jlcpcb?.[0]
    const value =
      c.display_resistance ?? c.display_capacitance ?? c.display_inductance ?? c.display_value ?? c.display_name ?? undefined
    return {
      name: c.name as string,
      kind: String(c.ftype ?? "component").replace(/^simple_/, ""),
      value,
      footprint: cad?.footprinter_string ?? undefined,
      mpn: c.manufacturer_part_number ?? undefined,
      lcsc,
      x: pcb ? round(pcb.center.x) : undefined,
      y: pcb ? round(pcb.center.y) : undefined,
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
  for (const [key, ports] of netGroups) {
    const named = srcNets.find((n) => n.subcircuit_connectivity_map_key === key)
    nets.push({
      name: named?.name ?? `N${anon++}`,
      pins: ports.map(pinName).sort(),
      ...(named?.is_power ? { isPower: true } : {}),
      ...(named?.is_ground ? { isGround: true } : {}),
    })
  }
  nets.sort((a, b) => b.pins.length - a.pins.length)

  // ---- routing completeness --------------------------------------------
  // A net with n pins needs n-1 connections. A pin counts as reached when some
  // trace endpoint lands on it.
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
    const message = String(e.message ?? code)
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
    if (INFO_CODES.has(code)) {
      d.severity = "info"
      info.push(d)
    } else if (/warning/.test(code)) {
      d.severity = "warning"
      warnings.push(d)
    } else {
      errors.push(d)
    }
  }
  // Fold the per-pin "not connected" cascade into one line so the root cause stays visible.
  const symptoms = errors.filter((e) => UNROUTED_CODES.has(e.code))
  if (symptoms.length) {
    const rootCause = errors.find((e) => !UNROUTED_CODES.has(e.code))
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
      hint: hintFor("autorouting", ""),
    })
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
  }
}
