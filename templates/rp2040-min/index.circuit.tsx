import { RP2040 } from "./lib/RP2040"
import { W25Q128JVSIQ } from "./lib/W25Q128JVSIQ"
import { X322512MSB4SI } from "./lib/X322512MSB4SI"
import { TS_1187A_B_A_B } from "./lib/TS_1187A_B_A_B"
import { AMS1117_3_3 } from "./lib/AMS1117_3_3"

const TOP = ["GND_A", "GND_B", "GP29", "GP28", "GP27", "GP26", "GP24", "GP23", "GP22", "GP21", "GP20", "GP19", "GP18", "GP17", "GP16", "RUN", "SWD", "SWCLK", "GND_C", "GND_D"]
const BOT = ["VBUS", "GND_E", "V3V3", "GND_F", "GP0", "GP1", "GP2", "GP3", "GP4", "GP5", "GP6", "GP7", "GP8", "GP9", "GP10", "GP11", "GP12", "GP13", "GP14", "GP15"]
const chipPin = (l: string) => {
  if (l === "SWD" || l === "SWCLK" || l === "RUN") return l
  const n = Number(l.slice(2))
  return n >= 26 ? `GPIO${n}_ADC${n - 26}` : `GPIO${n}`
}
const V33 = ["IOVDD1", "IOVDD2", "IOVDD3", "IOVDD4", "IOVDD5", "IOVDD6", "USB_VDD", "ADC_AVDD", "VREG_IN"]
const V11 = ["DVDD1", "DVDD2", "VREG_VOUT"]
const CX = 7

export default () => (
  <board width="58mm" height="32mm" routeRemaining={true}>
    <copperpour connectsTo="net.GND" layer="bottom" />
    <copperpour connectsTo="net.GND" layer="top" />

    <connector name="J1" standard="usb_c" pcbX={-23.5} pcbY={0} pcbRotation={-90} />
    <resistor name="R1" resistance="5.1k" footprint="0402" pcbX={-16.5} pcbY={3} />
    <resistor name="R2" resistance="5.1k" footprint="0402" pcbX={-16.5} pcbY={-3} />

    <AMS1117_3_3 name="U3" pcbX={-12.5} pcbY={7.5} pcbRotation={180} />
    <capacitor name="C1" capacitance="10uF" footprint="0805" pcbX={-18.6} pcbY={7} pcbRotation={90} />
    <capacitor name="C2" capacitance="10uF" footprint="0805" pcbX={-6.3} pcbY={7.5} pcbRotation={90} />

    <RP2040 name="U1" pcbX={CX} pcbY={0} pcbRotation={90} />
    <W25Q128JVSIQ name="U2" pcbX={-6} pcbY={-4} pcbRotation={-90} />
    <capacitor name="C8" capacitance="100nF" footprint="0402" pcbX={-2.6} pcbY={-0.3} />

    {/* RP2040 decoupling */}
    <capacitor name="C3" capacitance="100nF" footprint="0402" pcbX={3.4} pcbY={5.2} />
    <capacitor name="C4" capacitance="1uF" footprint="0402" pcbX={1.2} pcbY={4.2} />
    <capacitor name="C5" capacitance="1uF" footprint="0402" pcbX={1.4} pcbY={2.3} />
    <capacitor name="C6" capacitance="100nF" footprint="0402" pcbX={1.7} pcbY={0.35} />
    <capacitor name="C7" capacitance="100nF" footprint="0402" pcbX={-0.8} pcbY={3.0} />
    <capacitor name="C9" capacitance="100nF" footprint="0402" pcbX={4.0} pcbY={-5.6} pcbRotation={90} />
    <capacitor name="C10" capacitance="100nF" footprint="0402" pcbX={6.9} pcbY={-6.2} pcbRotation={90} />
    <capacitor name="C11" capacitance="100nF" footprint="0402" pcbX={7.0} pcbY={6.0} pcbRotation={90} />
    <capacitor name="C12" capacitance="100nF" footprint="0402" pcbX={12.8} pcbY={3.4} />
    <capacitor name="C13" capacitance="100nF" footprint="0402" pcbX={12.8} pcbY={4.6} />

    {/* USB series resistors */}
    <resistor name="R3" resistance="27" footprint="0402" pcbX={-0.5} pcbY={1.7} />
    <resistor name="R4" resistance="27" footprint="0402" pcbX={-0.5} pcbY={0.7} />

    {/* crystal */}
    <X322512MSB4SI name="Y1" loadCapacitance="20pF" pcbX={14.6} pcbY={0.25} />
    <capacitor name="C14" capacitance="27pF" footprint="0402" pcbX={13.5} pcbY={-2.6} pcbRotation={90} />
    <capacitor name="C15" capacitance="27pF" footprint="0402" pcbX={17.9} pcbY={1.1} />
    <resistor name="R5" resistance="1k" footprint="0402" pcbX={17.9} pcbY={2.5} />

    {/* buttons */}
    <TS_1187A_B_A_B name="SW1" pcbX={-15} pcbY={-7.3} />
    <resistor name="R6" resistance="1k" footprint="0402" pcbX={-10.3} pcbY={-8.2} pcbRotation={90} />
    <TS_1187A_B_A_B name="SW2" pcbX={23.5} pcbY={6.5} />
    <resistor name="R8" resistance="10k" footprint="0402" pcbX={17.5} pcbY={5} />

    {/* user LED on GPIO25 */}
    <resistor name="R7" resistance="470" footprint="0402" pcbX={22.5} pcbY={-4} />
    <led name="D1" color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} pcbX={25.2} pcbY={-4} />

    <pinheader name="J2" pinCount={20} pitch="2.54mm" gender="male" pinLabels={TOP} showSilkscreenPinLabels pcbX={0} pcbY={13.97} />
    <pinheader name="J3" pinCount={20} pitch="2.54mm" gender="male" pinLabels={BOT} showSilkscreenPinLabels pcbX={0} pcbY={-13.97} />

    {/* USB */}
    <trace from="J1.VBUS1" to="net.VBUS" thickness="0.4mm" />
    <trace from="J1.VBUS2" to="net.VBUS" thickness="0.4mm" />
    <trace from="J1.GND1" to="net.GND" />
    <trace from="J1.GND2" to="net.GND" />
    <trace from="J1.pin1" to="net.GND" />
    <trace from="J1.CC1" to="R1.pin1" />
    <trace from="R1.pin2" to="net.GND" />
    <trace from="J1.CC2" to="R2.pin1" />
    <trace from="R2.pin2" to="net.GND" />
    <trace from="J1.DP1" to="net.USB_DP" />
    <trace from="J1.DP2" to="net.USB_DP" />
    <trace from="J1.DM1" to="net.USB_DM" />
    <trace from="J1.DM2" to="net.USB_DM" />
    <trace from="R4.pin1" to="net.USB_DP" />
    <trace from="R4.pin2" to="U1.USB_DP" />
    <trace from="R3.pin1" to="net.USB_DM" />
    <trace from="R3.pin2" to="U1.USB_DM" />

    {/* LDO */}
    <trace from="U3.VIN" to="net.VBUS" thickness="0.4mm" />
    <trace from="U3.GND" to="net.GND" />
    <trace from="U3.VOUT1" to="net.V3_3" thickness="0.3mm" />
    <trace from="U3.VOUT2" to="net.V3_3" thickness="0.3mm" />
    <trace from="C1.pin1" to="net.VBUS" thickness="0.4mm" />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="C2.pin1" to="net.V3_3" thickness="0.3mm" />
    <trace from="C2.pin2" to="net.GND" />

    {/* RP2040 power */}
    {V33.map((p) => <trace key={p} from={`U1.${p}`} to="net.V3_3" />)}
    {V11.map((p) => <trace key={p} from={`U1.${p}`} to="net.V1_1" />)}
    <trace from="U1.GND" to="net.GND" />
    <trace from="U1.TESTEN" to="net.GND" />
    {["C3", "C4", "C6", "C8"].map((c) => <trace key={c} from={`${c}.pin2`} to="net.V3_3" />)}
    {["C3", "C4", "C6", "C8"].map((c) => <trace key={c + "g"} from={`${c}.pin1`} to="net.GND" />)}
    {["C9", "C10"].map((c) => <trace key={c} from={`${c}.pin2`} to="net.V3_3" />)}
    {["C9", "C10"].map((c) => <trace key={c + "g"} from={`${c}.pin1`} to="net.GND" />)}
    {["C11", "C12"].map((c) => <trace key={c} from={`${c}.pin1`} to="net.V3_3" />)}
    {["C11", "C12"].map((c) => <trace key={c + "g"} from={`${c}.pin2`} to="net.GND" />)}
    <trace from="C5.pin2" to="net.V1_1" />
    <trace from="C5.pin1" to="net.GND" />
    <trace from="C7.pin2" to="net.V1_1" />
    <trace from="C7.pin1" to="net.GND" />
    <trace from="C13.pin1" to="net.V1_1" />
    <trace from="C13.pin2" to="net.GND" />

    {/* flash */}
    <trace from="U2.VCC" to="net.V3_3" />
    <trace from="U2.GND" to="net.GND" />
    <trace from="U2.N_CS" to="net.QSPI_SS" />
    <trace from="U1.QSPI_SS" to="net.QSPI_SS" />
    <trace from="R6.pin2" to="net.QSPI_SS" />
    <trace from="U2.DO" to="U1.QSPI_SD1" />
    <trace from="U2.IO2" to="U1.QSPI_SD2" />
    <trace from="U2.DI" to="U1.QSPI_SD0" />
    <trace from="U2.CLK" to="U1.QSPI_SCLK" />
    <trace from="U2.IO3" to="U1.QSPI_SD3" />
    <trace from="R6.pin1" to="SW1.D" />
    <trace from="SW1.A" to="net.GND" />

    {/* crystal */}
    <trace from="U1.XIN" to="Y1.pin1" />
    <trace from="C14.pin2" to="Y1.pin1" />
    <trace from="C14.pin1" to="net.GND" />
    <trace from="U1.XOUT" to="R5.pin2" />
    <trace from="R5.pin1" to="C15.pin1" />
    <trace from="C15.pin1" to="Y1.pin3" />
    <trace from="C15.pin2" to="net.GND" />
    <trace from="Y1.pin2" to="net.GND" />
    <trace from="Y1.pin4" to="net.GND" />

    {/* reset */}
    <trace from="U1.RUN" to="net.RUN" />
    <trace from="R8.pin1" to="net.RUN" />
    <trace from="R8.pin2" to="net.V3_3" />
    <trace from="SW2.A" to="net.RUN" />
    <trace from="SW2.D" to="net.GND" />

    {/* LED */}
    <trace from="U1.GPIO25" to="R7.pin1" />
    <trace from="R7.pin2" to="D1.anode" />
    <trace from="D1.cathode" to="net.GND" />

    {/* headers */}
    {TOP.map((l) => l.startsWith("GND") ? <trace key={l} from={`J2.${l}`} to="net.GND" /> : l === "RUN" ? <trace key={l} from="J2.RUN" to="net.RUN" /> : <trace key={l} from={`J2.${l}`} to={`U1.${chipPin(l)}`} />)}
    {BOT.map((l) => l.startsWith("GND") ? <trace key={l} from={`J3.${l}`} to="net.GND" /> : l === "VBUS" ? <trace key={l} from="J3.VBUS" to="net.VBUS" thickness="0.4mm" /> : l === "V3V3" ? <trace key={l} from="J3.V3V3" to="net.V3_3" /> : <trace key={l} from={`J3.${l}`} to={`U1.${chipPin(l)}`} />)}
  </board>
)
