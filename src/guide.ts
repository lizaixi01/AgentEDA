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
5. Where the board has analog behaviour worth checking, add a simulation testbench and compare the numbers.
6. \`export_fab\` -> gerbers.zip, bom.csv, cpl.csv for JLCPCB. Check \`verification.ok\` in the result.
7. Write \`NOTES.md\` (see "Leave a design note"). \`export_report\` then gives the user one HTML file with everything for review.

Every successful build writes \`.aeda/pcb.svg\`, \`schematic.svg\` and \`assembly.svg\` in the project folder (listed as \`previews\`). \`render\` turns one into a PNG you can look at.

Do not stop at the first green build if warnings name real problems (unrouted nets, clearance).
\`bom_part_not_sourced\` is only a warning: fine for hand-soldered headers, fix it for anything JLCPCB should assemble.

## Leave a design note

When the board passes, write \`NOTES.md\` in the project (write_file with path "NOTES.md"), in the user's language. The web app shows it next to the board. Keep it to what a reviewer needs before ordering:

- what the board does, the rails and key parts, and the numbers you calculated (resistor values, currents, cutoff frequencies)
- assumptions you made where the request was silent
- what the automated checks cannot verify and you did not confirm against a datasheet (pinouts of imported parts, connector polarity, thermal limits)
- known compromises (no fuse, no ESD protection, decoupling further from the pin than ideal ...)

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
| \`<led>\` | color="red", footprint, supplierPartNumbers (see LEDs below) | anode, cathode |
| \`<diode>\` | footprint (e.g. sod123); prefer import_part | anode, cathode |
| \`<transistor>\` | type="npn" or "pnp", footprint="sot23" | base, collector, emitter |
| \`<mosfet>\` | channelType="n" or "p", mosfetMode="enhancement", footprint="sot23"; prefer import_part | gate, drain, source |
| \`<crystal>\` | frequency="16MHz", loadCapacitance="18pF", footprint | pin1, pin2 |
| \`<pushbutton>\` | footprint="pushbutton" (pin1+pin2 are one side, pin3+pin4 the other); prefer import_part | pin1, pin2, pin3, pin4 |
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

## LEDs and diodes (polarity)

A generic \`<led footprint="0603">\` only assembles the right way round with a supplier part whose pin 1 is the anode.
Two safe options:

- Known-good generics: red 0603 \`supplierPartNumbers={{ jlcpcb: ["C2286"] }}\`, white 0603 \`{{ jlcpcb: ["C2290"] }}\` (both JLCPCB basic parts).
- Any other colour, size or diode: \`import_part\` the exact LCSC part and use the generated component; its \`anode\`/\`cathode\` pins are right.

If build reports \`source_component_misconfigured_error\`, this is why. Do not leave the part choice of an LED to chance.

## Parts that are known to work

| Part | LCSC | Notes |
|---|---|---|
| 100 nF 0603 capacitor | C14663 | basic; generic passives are matched automatically, no number needed |
| 10 k 0603 resistor | C25804 | basic; same |
| AMS1117-3.3 LDO, SOT-223 | C6186 | basic; pins GND, VOUT, VIN, tab = VOUT |
| NE555 timer, SOIC-8 | C7593 | |
| Red LED 0603 | C2286 | basic, pin 1 = anode |
| White LED 0603 | C2290 | basic, pin 1 = anode |

Everything else: find it, prefer \`basic: true\` and deep stock, then \`import_part\`. Two ways to find a part:

- \`search_parts\` when you know the part number or family ("TP4056", "CH340C", "ESP32-C3-MINI").
- \`browse_parts\` when you know the kind of part: a category plus filters, e.g. category "jst_connectors" where "num_pins=2,pitch_mm=2" contains "PH"; category "switches" contains "slide"; category "capacitors" package "0805" where "capacitance=10uF" (rows show \`voltage_rating\`); category "leds" package "0603" where "color=green". Each result lists the category's \`filterableAttributes\`.

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

- Selector is \`Name.pin\` (the older form \`".Name > .pin"\` means the same). Pin is a label from pinLabels or \`pinN\`.
- Use named nets for power and anything with 3+ pins: every pin on \`net.GND\` is connected together.
- Net names: letters, digits, underscore; must start with a letter (\`V3_3\`, not \`3V3\`).
- Ask \`build\` with \`detail: true\` (or \`get_report\`) to see each component's real pin names.
- Power paths: \`<trace from="U1.VIN" to="net.V5" thickness="0.5mm" />\`. Default width is 0.15 mm, which suits signals and up to about 0.3 A. Put \`thickness\` on every trace of a rail that carries more (about 0.4 mm per amp). \`build\` lists \`power_trace_thin\` under \`notes\` (advisory: you know the current, the tool does not) and \`nets[].traceWidthMm\` (with detail) shows what was routed.

## Placement

Leave \`pcbX\`/\`pcbY\` off and parts are auto-packed around the centre. Add them when it matters:

\`\`\`tsx
<connector name="J1" standard="usb_c" pcbX={-12} pcbY={0} pcbRotation={90} />
<capacitor name="C1" capacitance="100nF" footprint="0402" pcbX={2} pcbY={3} />   {/* decoupling next to U1 */}
<resistor name="R9" resistance="10k" footprint="0402" layer="bottom" />
\`\`\`

Ground plane (do this on every board with an IC): \`<copperpour connectsTo="net.GND" layer="bottom" />\`.
A pour only appears if something on its net exists on that layer: a bottom pour needs through-hole GND pins (headers) or vias; on an all-SMD board use \`layer="top"\`. Build warns \`copper_pour_empty\` otherwise.

Facts that save a rebuild:
- \`<connector standard="usb_c">\` with no rotation opens towards -y, so put it at the bottom edge (pcbY about -(height/2) + 5.5). \`pcbRotation={-90}\` opens towards -x (left edge). If it faces inward, build warns \`connector_not_in_accessible_orientation\` and says which way it faces.
- A part may not cross the board outline; the error says by how many mm and in which direction to move it. Parts that are meant to overhang (USB socket lip, a side-actuated switch lever) take \`allowOffBoard\`: \`<MySwitch name="SW1" pcbX={9} allowOffBoard />\`.
- \`components[].x / y\` in the report are the part origin, the same point pcbX / pcbY set. \`widthMm / heightMm\` are its pad bounds.
- \`import_part\` returns \`footprint.pads\` (position and size of every pad, relative to the origin) and \`padBoundsMm\`. Use them to tell signal pads from mounting tabs and to see which side the body is on. Imported connectors and switches often have unlabeled pins (pin1..pinN): read the pad table, then check with \`render\`.
- For USB-C prefer the built-in \`<connector standard="usb_c" />\`: it has named pins and the USB-C checks know it. An imported USB-C socket works too but its pins are contact numbers (A5/B5 = CC1/CC2, A4/A9/B4/B9 = VBUS, A1/A12/B1/B12 = GND).
- Designators printed over another part's pads or over each other are listed under \`notes\` as \`silkscreen_overlap\`. Cosmetic; fix by giving the parts more room.
- 4-pad tactile switches: wire the two *diagonal* pads (top-left and bottom-right). Diagonal pads are always on opposite sides of the switch, whichever way the pairs are joined internally.
- Screw terminals and other large through-hole connectors have courtyards around 11 x 11 mm. Budget for them; three terminals do not fit on a 30 mm board.
- Fine-pitch IC pins (TSSOP, QFN) cannot take a wide trace: build warns "routed thinner than requested" and necks the trace at the pin. That is normal; keep the wide trace for the rest of the run.
- \`import_part\` drops thermal vias from exposed-pad footprints (they block routing) and says so. Give such chips a ground pour on both layers instead.
- Radio modules (ESP32 etc.): antenna end at a board edge, nothing under the antenna. Clear the ground pour there with a keepout on the pour's layer: \`<keepout shape="rect" pcbX={0} pcbY={19.9} width="14mm" height="6mm" layers={["bottom"]} />\`. Do not put the keepout on the layer the module itself sits on; it collides with the module's own footprint.

To move one part without retyping its element, call \`place_component\` (name, x, y, rotation, layer). It edits pcbX / pcbY / pcbRotation / layer in the source for parts written with a literal name.

\`summary.areaUsedPct\` is how much of the board the parts cover: below about 15 you can shrink the board. Hand-placed boards have routed at 60; above that expect routing failures.
Auto-placement packs parts tightly without regard to what connects to what. For more than about six parts, give every part pcbX / pcbY yourself: group each IC with its support parts.
Default orientations at rotation 0: a pin header runs left to right with pin 1 on the left; an LED has its anode on the left.
\`<pinheader showSilkscreenPinLabels />\` prints the pin labels on the silkscreen.
The built-in USB-C connector has one extra pin called \`pin1\`: it is the metal shell (its four mounting lugs). Tie it to GND: \`<trace from="J1.pin1" to="net.GND" />\`.

Bigger boards:
- More than 50 connections: add \`routeRemaining\` to the board (\`<board width="58mm" height="32mm" routeRemaining>\`), otherwise routing is refused with "over 50 traces remaining".
- Errors arrive in stages: outside-board and overlap errors first, routing only once placement is clean, clearance errors after routing. Expect a few builds; fix what each one reports.
- \`pcbRotation\` is counter-clockwise, in degrees.
- Crystal nets are constrained automatically (no vias, at most 10 mm). Put the crystal and its two load capacitors right next to the oscillator pins on the same layer. An imported crystal needs \`frequency\` and \`loadCapacitance\` props where you use it.
- For a QFN or QFP with many broken-out pins: rotate the chip so each side faces the header its pins go to, and order the header pins the way they leave the chip.
- There is no differential-pair routing: keep USB D+ / D- short and place the connector near the chip.

Rules of thumb: connectors on the edge, decoupling caps within 2-3 mm of the power pin they serve,
crystal next to its pins, leave at least 0.5 mm between courtyards, start with a board ~40% larger than
you think you need and shrink once it routes. \`<group pcbX={..} pcbY={..}>\` moves a cluster together.

## Simulation: check that the circuit works, not just that it is wired

Add a testbench to the same file. Sources and probes are simulation-only: they are not placed on the PCB and not in the BOM.

\`\`\`tsx
<voltagesource name="V1" voltage="5V" />                                  {/* DC supply */}
<voltagesource name="V2" waveShape="square" voltage="3.3V" frequency="1kHz" dutyCycle={0.5} />
<trace from="V1.pin1" to="net.V5" />
<trace from="V1.pin2" to="net.GND" />
<voltageprobe name="VP_OUT" connectsTo="J2.OUT" />                        {/* name must differ from every net name */}
<analogsimulation duration="4ms" timePerStep="0.01ms" spiceEngine="ngspice" />
\`\`\`

Always connect a source to named nets (\`to="net.V5"\`), never straight to a part's pin: a pin-to-pin trace to a source has no copper to route and stops the whole board from routing.

\`build\` then returns \`simulation.probes[]\` with \`minV\`, \`maxV\`, \`meanV\`, \`finalV\`, \`peakToPeakV\`, \`frequencyHz\`, \`dutyCycle\` for each probe.
Compare them with what the circuit should do (a divider ratio, a filter's attenuation, an LED node voltage) and fix the design if they disagree.
\`waveShape\` is "sinewave", "square", "triangle" or "sawtooth". A sinewave of \`voltage="2V"\` swings -2 V to +2 V around zero; a square wave goes 0 V to \`voltage\`. There is no DC offset prop and sources cannot be stacked in series: to study "DC plus ripple", run the DC case and the AC case as two builds.
Each probe also has \`settled\` (min / max / mean / peak-to-peak over the second half of the run). Use \`settled\` for steady-state values; the plain fields include the start-up transient from 0 V.
If the simulator returns nothing, build fails with \`simulation_no_result\`. Pick a duration that covers several periods and a step at least 50x shorter than the period.
LEDs and diodes simulate with one generic diode model: forward voltages come out too low for blue/white LEDs (about 2.3 V instead of 3 V), so LED currents are overestimated. Compute LED current by hand from the datasheet Vf.
Limits: ideal R, C, L, diodes, transistors and sources simulate; ICs and modules without a SPICE model do not. Use simulation for the analog parts of a board (dividers, filters, bias networks, LED currents), not for digital behaviour.

## Reusing code

It is TSX: use loops and components.

\`\`\`tsx
{[0, 1, 2, 3].map((i) => (
  <led key={i} name={\`D\${i + 1}\`} color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} pcbX={-6 + i * 4} pcbY={5} />
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
| layout_open | The independent connectivity check found a net whose pins are not all joined by copper. Rebuild with the parts closer together or with more room to route. |
| supplier_footprint_wrong_package | The footprint does not fit the chosen supplier part. import_part the exact part, or pick a part in this package. |
| short_circuit / copper_spacing | The independent geometry check found different nets touching or closer than 0.1 mm at the stated coordinates. Move the parts near that point apart; rebuild. |
| source_component_misconfigured_error | LED/diode polarity differs from the supplier part. import_part it, or use C2286 / C2290. |
| invalid_value | A value did not parse. Use "10k", "100nF", "10uH", "16MHz". |
| bom_low_stock | Pick a better-stocked part with search_parts. |
| erc_led_no_resistor / erc_usb_c_cc / erc_missing_decoupling / erc_i2c_no_pullup | A standard support part is missing. Add it (the hint says which), or state why it is not needed. |
| erc_power_pin_unconnected | An IC supply or ground pin floats. Wire it. |
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
    <led name="D1" color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} />
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

## Engineering sanity (build flags only the commonest cases as erc_* findings; you own the rest)

- Every IC power pin gets a 100 nF cap to ground, close by.
- USB-C sink: 5.1 k from CC1 and from CC2 to GND, or the charger supplies nothing.
- LED needs a series resistor: R = (Vsupply - Vf) / I, with I around 2-10 mA.
- Regulators need the input and output capacitors their datasheet names.
- Pull-ups on I2C (4.7 k), on reset/enable pins, on open-drain outputs.
- Check each part's absolute maximum voltage against the rail feeding it.
- State assumptions you made (rail voltages, currents, connector choice) when you report back.
`
