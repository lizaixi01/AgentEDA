import { ESP32_C3_MINI_1_N4 } from "./lib/ESP32_C3_MINI_1_N4"
import { TS_1187A_B_A_B } from "./lib/TS_1187A_B_A_B"
import { AMS1117_3_3 } from "./lib/AMS1117_3_3"

// ESP32-C3-MINI-1 minimal dev board.
// USB-C (5 V) -> AMS1117-3.3 -> module. Native USB on IO18/IO19 for flashing.
// EN: 10k pull-up + 1uF, reset button. IO9: BOOT button. IO8: 10k pull-up (strapping).
// IO10: status LED.

const moduleGnd = Array.from({ length: 22 }, (_, i) => `GND${i + 1}`)
const leftPins = ["V3_3", "GND", "IO0", "IO1", "IO2", "IO3", "IO4", "IO5"]
const rightPins = ["V5", "GND", "IO6", "IO7", "IO10", "RXD0", "TXD0", "EN"]

export default () => (
  <board width="30mm" height="52mm">
    {/* --- MCU module, antenna towards the top edge --- */}
    <ESP32_C3_MINI_1_N4 name="U1" pcbX={0} pcbY={14.5} />
    <capacitor name="C1" capacitance="10uF" footprint="0805" pcbX={-4} pcbY={4} />
    <capacitor name="C2" capacitance="100nF" footprint="0402" pcbX={-1} pcbY={4} />
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={2} pcbY={4} />
    <capacitor name="C3" capacitance="1uF" footprint="0402" pcbX={4.5} pcbY={4} />
    <resistor name="R2" resistance="10k" footprint="0402" pcbX={7} pcbY={4} />

    {/* --- power: USB-C -> LDO --- */}
    <connector name="J1" standard="usb_c" pcbX={0} pcbY={-20.5} />
    <resistor name="R3" resistance="5.1k" footprint="0402" pcbX={-5.5} pcbY={-15.5} />
    <resistor name="R4" resistance="5.1k" footprint="0402" pcbX={5.5} pcbY={-15.5} />
    <AMS1117_3_3 name="U2" pcbX={0} pcbY={-7} />
    <capacitor name="C4" capacitance="10uF" footprint="0805" pcbX={-6.5} pcbY={-9} />
    <capacitor name="C5" capacitance="22uF" footprint="0805" pcbX={6.5} pcbY={-5} />

    {/* --- buttons and LED --- */}
    <TS_1187A_B_A_B name="SW1" pcbX={-9} pcbY={-20} />
    <TS_1187A_B_A_B name="SW2" pcbX={9} pcbY={-20} />
    <resistor name="R5" resistance="1k" footprint="0402" pcbX={5} pcbY={-0.5} />
    <led name="D1" color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} pcbX={8} pcbY={-0.5} />

    {/* --- headers --- */}
    <pinheader name="J2" pinCount={8} pitch="2.54mm" pinLabels={leftPins} pcbX={-12.7} pcbY={2} pcbRotation={90} />
    <pinheader name="J3" pinCount={8} pitch="2.54mm" pinLabels={rightPins} pcbX={12.7} pcbY={2} pcbRotation={90} />

    {/* --- ground plane on the bottom layer --- */}
    <copperpour connectsTo="net.GND" layer="bottom" />
    {/* no copper under the module antenna (top 6 mm of the module) */}
    <keepout shape="rect" pcbX={0} pcbY={19.9} width="14mm" height="6mm" layers={["bottom"]} />

    {/* --- nets: power --- */}
    <trace from="J1.VBUS1" to="net.V5" thickness="0.4mm" />
    <trace from="J1.VBUS2" to="net.V5" thickness="0.4mm" />
    <trace from="J1.GND1" to="net.GND" />
    <trace from="J1.GND2" to="net.GND" />
    <trace from="J1.CC1" to="R3.pin1" />
    <trace from="R3.pin2" to="net.GND" />
    <trace from="J1.CC2" to="R4.pin1" />
    <trace from="R4.pin2" to="net.GND" />
    <trace from="U2.VIN" to="net.V5" thickness="0.4mm" />
    <trace from="U2.GND" to="net.GND" />
    <trace from="U2.VOUT1" to="net.V3_3" thickness="0.4mm" />
    <trace from="U2.VOUT2" to="net.V3_3" thickness="0.4mm" />
    <trace from="C4.pin1" to="net.V5" thickness="0.4mm" />
    <trace from="C4.pin2" to="net.GND" />
    <trace from="C5.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="C5.pin2" to="net.GND" />

    {/* --- nets: module --- */}
    <trace from="U1.3V3" to="net.V3_3" thickness="0.4mm" />
    {moduleGnd.map((g) => (
      <trace key={g} from={`U1.${g}`} to="net.GND" />
    ))}
    <trace from="C1.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="C2.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="C2.pin2" to="net.GND" />
    <trace from="R1.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="R1.pin2" to="net.EN" />
    <trace from="C3.pin1" to="net.EN" />
    <trace from="C3.pin2" to="net.GND" />
    <trace from="U1.EN" to="net.EN" />
    <trace from="R2.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="R2.pin2" to="net.IO8" />
    <trace from="U1.IO8" to="net.IO8" />

    {/* --- USB data --- */}
    <trace from="J1.DM1" to="net.USB_DM" />
    <trace from="J1.DM2" to="net.USB_DM" />
    <trace from="J1.DP1" to="net.USB_DP" />
    <trace from="J1.DP2" to="net.USB_DP" />
    <trace from="U1.IO18" to="net.USB_DM" />
    <trace from="U1.IO19" to="net.USB_DP" />

    {/* --- buttons (diagonal pads are always opposite switch terminals) --- */}
    <trace from="SW1.A" to="net.EN" />
    <trace from="SW1.D" to="net.GND" />
    <trace from="SW2.A" to="net.IO9" />
    <trace from="SW2.D" to="net.GND" />
    <trace from="U1.IO9" to="net.IO9" />

    {/* --- LED --- */}
    <trace from="U1.IO10" to="net.IO10" />
    <trace from="R5.pin1" to="net.IO10" />
    <trace from="R5.pin2" to="D1.anode" />
    <trace from="D1.cathode" to="net.GND" />

    {/* --- headers --- */}
    <trace from="J2.V3_3" to="net.V3_3" thickness="0.4mm" />
    <trace from="J2.GND" to="net.GND" />
    {["IO0", "IO1", "IO2", "IO3", "IO4", "IO5"].map((io) => (
      <trace key={io} from={`J2.${io}`} to={`U1.${io}`} />
    ))}
    <trace from="J3.V5" to="net.V5" thickness="0.4mm" />
    <trace from="J3.GND" to="net.GND" />
    <trace from="J3.IO6" to="U1.IO6" />
    <trace from="J3.IO7" to="U1.IO7" />
    <trace from="J3.IO10" to="net.IO10" />
    <trace from="J3.RXD0" to="U1.RXD0" />
    <trace from="J3.TXD0" to="U1.TXD0" />
    <trace from="J3.EN" to="net.EN" />
  </board>
)
