/**
 * The design guide handed to agents (get_guide tool, `aeda guide`, the chat agent's system prompt
 * and the Claude skill). Keep it short enough to read in one go; keep every example buildable.
 */
export const GUIDE = `# AgentEDA design guide

You design a PCB by writing one TSX file, \`index.circuit.tsx\`, then calling **build**.
Build places parts, autoroutes copper, matches JLCPCB parts and runs ERC/DRC. You fix what it
reports and build again until \`ok: true\`, then call **export_fab**. You never draw; you declare.

## The loop

1. \`create_project\` (pass the first version as \`code\`).
2. For every IC, module or special connector: \`search_parts\` -> \`import_part\` (gives exact footprint + pin names).
3. \`write_file\` / \`edit_file\` the design.
4. \`build\` -> read \`errors\` (each has a \`hint\`) -> edit -> \`build\`. Repeat until \`ok\` is true.
5. \`export_fab\` -> gerbers.zip, bom.csv, cpl.csv for JLCPCB.

Do not stop at the first green build if warnings name real problems (unrouted nets, clearance).
\`bom_part_not_sourced\` is only a warning: fine for hand-soldered headers, fix it for anything JLCPCB should assemble.

## File shape

\`\`\`tsx
export default () => (
  <board width="30mm" height="20mm">
    {/* parts */}
    {/* traces */}
  </board>
)
\`\`\`

- Units are mm. Numbers are mm; strings may carry units ("2.54mm", "0.1in", "10k", "100nF").
- Board centre is (0, 0). +x right, +y up.
- Every part needs a unique \`name\` (R1, C3, U2, J1 ...).
- No imports are needed for built-in elements. Import your own parts from \`./lib/...\`.

## Built-in parts

| Element | Required props | Pins |
|---|---|---|
| \`<resistor>\` | resistance="10k", footprint | pin1, pin2 |
| \`<capacitor>\` | capacitance="100nF", footprint (add \`polarized\` for electrolytics) | pin1, pin2 (polarized: anode/pos, cathode/neg) |
| \`<inductor>\` | inductance="10uH", footprint | pin1, pin2 |
| \`<led>\` | color="red", footprint | anode, cathode |
| \`<diode>\` | footprint (e.g. sod123) | anode, cathode |
| \`<transistor>\` | type="npn" or "pnp", footprint="sot23" | base, collector, emitter |
| \`<mosfet>\` | channelType="n" or "p", mosfetMode="enhancement", footprint="sot23" | gate, drain, source |
| \`<crystal>\` | frequency="16MHz", loadCapacitance="18pF", footprint | pin1, pin2 |
| \`<pushbutton>\` | footprint="pushbutton" | pin1, pin2 (and pin3, pin4 on 4-pad parts) |
| \`<pinheader>\` | pinCount={4}, pitch="2.54mm", optional pinLabels={["VCC","GND","SDA","SCL"]}, gender="male" | pin1..pinN or your labels |
| \`<connector>\` | standard="usb_c" for USB-C | VBUS1, VBUS2, GND1, GND2, DP1, DP2, DM1, DM2, CC1, CC2 ... |
| \`<chip>\` | footprint, pinLabels | your labels, or pin1..pinN |
| \`<hole>\` | diameter="3.2mm", pcbX, pcbY | none (mounting hole) |
| \`<testpoint>\` | footprintVariant="pad", padDiameter="1.5mm" | pin1 |

## Chips

Give every chip \`pinLabels\` so traces read like the datasheet:

\`\`\`tsx
<chip
  name="U1"
  footprint="soic8"
  manufacturerPartNumber="NE555DR"
  supplierPartNumbers={{ jlcpcb: ["C7593"] }}
  pinLabels={{ pin1: "GND", pin2: "TRIG", pin3: "OUT", pin4: "RESET", pin5: "CTRL", pin6: "THRES", pin7: "DISCH", pin8: "VCC" }}
  pinAttributes={{ VCC: { requiresPower: true }, GND: { requiresGround: true } }}
/>
\`\`\`

Better: \`import_part\` with the LCSC number. It writes \`lib/<Name>.tsx\` with the true land pattern and
pin names, and returns the import line. Then: \`<AMS1117_3_3 name="U2" />\`.
Never guess a footprint for an IC or connector; import it.

## Footprint strings

Passives: 0402 0603 0805 1206 (resistor/capacitor/led/inductor). Through-hole: axial_p0.2in, radial_p2.54mm.
Diodes: sod123 sod323 sma smb. Transistors/regulators: sot23 sot23_5 sot223 sot89 to92 to220.
ICs: soic8 soic16 tssop20 msop10 qfn32_w5_h5_p0.5mm_thermalpad tqfp32_w7_h7_p0.8mm lqfp48_w7_h7_p0.5mm dip8.
Connectors: pinrow4_p2.54mm, pinrow6_p2.54mm_rows2, jst2_p2mm_ph, jst4_p1mm_sh. Crystal: hc49, crystal4_px2.5mm_py2mm.
Exact land pattern straight from JLCPCB: footprint="jlcpcb:C2040".

## Wiring

\`\`\`tsx
<trace from="R1.pin2" to="D1.anode" />          {/* pin to pin */}
<trace from="U1.VCC" to="net.V3_3" />            {/* pin to named net */}
<trace from="U1.GND" to="net.GND" />
\`\`\`

- Selector is \`Name.pin\`. Pin is a label from pinLabels or \`pinN\`.
- Use named nets for power and anything with 3+ pins: every pin on \`net.GND\` is connected together.
- Net names: letters, digits, underscore; must start with a letter (\`V3_3\`, not \`3V3\`).
- Ask \`build\` with \`detail: true\` (or \`get_report\`) to see each component's real pin names.
- Optional: \`<trace ... thickness="0.4mm" />\` for power paths.

## Placement

Leave \`pcbX\`/\`pcbY\` off and parts are auto-packed around the centre. Add them when it matters:

\`\`\`tsx
<connector name="J1" standard="usb_c" pcbX={-12} pcbY={0} pcbRotation={90} />
<capacitor name="C1" capacitance="100nF" footprint="0402" pcbX={2} pcbY={3} />   {/* decoupling next to U1 */}
<led name="D1" color="green" footprint="0603" layer="bottom" />
\`\`\`

Rules of thumb: connectors on the edge, decoupling caps within 2-3 mm of the power pin they serve,
crystal next to its pins, leave at least 0.5 mm between courtyards, start with a board ~40% larger than
you think you need and shrink once it routes. \`<group pcbX={..} pcbY={..}>\` moves a cluster together.

## Reusing code

It is TSX: use loops and components.

\`\`\`tsx
{[0, 1, 2, 3].map((i) => (
  <led key={i} name={\`D\${i + 1}\`} color="red" footprint="0603" pcbX={-6 + i * 4} pcbY={5} />
))}
\`\`\`

## When build fails

| Report says | Do |
|---|---|
| compile_import | Syntax error or bad import. Read the line number, fix the TSX. |
| compile_render | A prop is wrong (unit, enum) or a selector points at nothing. |
| port not found / selector | Pin name is wrong. Check \`components[].pins\` via detail. |
| autorouting / unrouted_connections | Not enough room. Enlarge board, spread parts, place related parts adjacent. |
| overlap / courtyard | Two parts collide. Give explicit pcbX/pcbY or enlarge board. |
| clearance / trace_error | Copper too close. Move parts apart; rebuild re-routes. |
| supplier_footprint_mismatch | Harmless for generic passives. For ICs, import the exact part. |
| bom_part_not_sourced | \`search_parts\`, then supplierPartNumbers={{ jlcpcb: ["C..."] }} or \`import_part\`. |

Change one thing, rebuild, compare \`summary\`. If a change made it worse, \`restore_version\`.

## Complete example: USB-C powered 3.3 V regulator with power LED

\`\`\`tsx
export default () => (
  <board width="32mm" height="20mm">
    <connector name="J1" standard="usb_c" pcbX={-10} pcbY={0} pcbRotation={-90} />
    <chip
      name="U1"
      footprint="sot223"
      manufacturerPartNumber="AMS1117-3.3"
      supplierPartNumbers={{ jlcpcb: ["C6186"] }}
      pinLabels={{ pin1: "GND", pin2: "VOUT", pin3: "VIN", pin4: "TAB" }}
      pcbX={2}
      pcbY={0}
    />
    <resistor name="R1" resistance="5.1k" footprint="0402" />
    <resistor name="R2" resistance="5.1k" footprint="0402" />
    <capacitor name="C1" capacitance="10uF" footprint="0805" />
    <capacitor name="C2" capacitance="10uF" footprint="0805" />
    <resistor name="R3" resistance="1k" footprint="0402" />
    <led name="D1" color="green" footprint="0603" />
    <pinheader name="J2" pinCount={2} pitch="2.54mm" pinLabels={["V3_3", "GND"]} pcbX={12} pcbY={0} pcbRotation={90} />

    <trace from="J1.VBUS1" to="net.VBUS" />
    <trace from="J1.VBUS2" to="net.VBUS" />
    <trace from="J1.GND1" to="net.GND" />
    <trace from="J1.GND2" to="net.GND" />
    <trace from="J1.CC1" to="R1.pin1" />
    <trace from="R1.pin2" to="net.GND" />
    <trace from="J1.CC2" to="R2.pin1" />
    <trace from="R2.pin2" to="net.GND" />

    <trace from="U1.VIN" to="net.VBUS" />
    <trace from="U1.GND" to="net.GND" />
    <trace from="U1.VOUT" to="net.V3_3" />
    <trace from="U1.TAB" to="net.V3_3" />
    <trace from="C1.pin1" to="net.VBUS" />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="C2.pin1" to="net.V3_3" />
    <trace from="C2.pin2" to="net.GND" />

    <trace from="R3.pin1" to="net.V3_3" />
    <trace from="R3.pin2" to="D1.anode" />
    <trace from="D1.cathode" to="net.GND" />
    <trace from="J2.V3_3" to="net.V3_3" />
    <trace from="J2.GND" to="net.GND" />
  </board>
)
\`\`\`

## Engineering sanity (the checks cannot see these; you must)

- Every IC power pin gets a 100 nF cap to ground, close by.
- USB-C sink: 5.1 k from CC1 and from CC2 to GND, or the charger supplies nothing.
- LED needs a series resistor: R = (Vsupply - Vf) / I, with I around 2-10 mA.
- Regulators need the input and output capacitors their datasheet names.
- Pull-ups on I2C (4.7 k), on reset/enable pins, on open-drain outputs.
- Check each part's absolute maximum voltage against the rail feeding it.
- State assumptions you made (rail voltages, currents, connector choice) when you report back.
`
