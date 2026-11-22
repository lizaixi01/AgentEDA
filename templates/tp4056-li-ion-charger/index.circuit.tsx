import { TP4056 } from "./lib/TP4056"
import { XY_PH2_0_2A61 } from "./lib/XY_PH2_0_2A61"
import { A_19_217_GHC_YR1S2_3T as GreenLed } from "./lib/A_19_217_GHC_YR1S2_3T"

// Single-cell Li-ion charger. USB-C 5 V in -> TP4056 linear charger -> battery on a PH2.0 socket.
// Charge current: I = 1200 / R_PROG = 1200 / 2k = 600 mA.
// Power nets (VBUS, VBAT) are routed 0.5 mm wide for the 0.6 A charge current.
// D1 (red) on while charging, D2 (green) on when full. No battery protection IC on this board:
// use a protected cell.
export default () => (
  <board width="22mm" height="40mm">
    <connector name="J1" standard="usb_c" pcbX={0} pcbY={-14.5} />
    <resistor name="R1" resistance="5.1k" footprint="0402" pcbX={-6} pcbY={-9.5} />
    <resistor name="R2" resistance="5.1k" footprint="0402" pcbX={6} pcbY={-9.5} />

    <TP4056 name="U1" pcbX={0} pcbY={-2} />
    <capacitor name="C1" capacitance="10uF" footprint="0805" pcbX={-7} pcbY={-3.5} pcbRotation={90} />
    <capacitor name="C2" capacitance="10uF" footprint="0805" pcbX={7} pcbY={-3.5} pcbRotation={90} />
    <resistor name="R3" resistance="2k" footprint="0402" pcbX={-5.5} pcbY={2.5} />

    <resistor name="R4" resistance="1k" footprint="0402" pcbX={5.5} pcbY={2} />
    <resistor name="R5" resistance="1k" footprint="0402" pcbX={5.5} pcbY={4.2} />
    <led name="D1" color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} pcbX={8.5} pcbY={2} />
    <GreenLed name="D2" pcbX={8.5} pcbY={4.5} />

    <XY_PH2_0_2A61 name="J2" pcbX={0} pcbY={13.5} pcbRotation={180} />

    <copperpour connectsTo="net.GND" layer="top" />

    {/* USB-C power input */}
    <trace from="J1.VBUS1" to="net.VBUS" thickness="0.5mm" />
    <trace from="J1.VBUS2" to="net.VBUS" thickness="0.5mm" />
    <trace from="J1.GND1" to="net.GND" />
    <trace from="J1.GND2" to="net.GND" />
    <trace from="J1.CC1" to="R1.pin1" />
    <trace from="R1.pin2" to="net.GND" />
    <trace from="J1.CC2" to="R2.pin1" />
    <trace from="R2.pin2" to="net.GND" />

    {/* charger */}
    <trace from="U1.VCC" to="net.VBUS" thickness="0.5mm" />
    <trace from="U1.CE" to="net.VBUS" thickness="0.5mm" />
    <trace from="U1.GND" to="net.GND" />
    <trace from="U1.EP" to="net.GND" />
    <trace from="U1.TEMP" to="net.GND" />
    <trace from="U1.PROG" to="R3.pin1" />
    <trace from="R3.pin2" to="net.GND" />
    <trace from="U1.BAT" to="net.VBAT" thickness="0.5mm" />
    <trace from="C1.pin1" to="net.VBUS" thickness="0.5mm" />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="C2.pin1" to="net.VBAT" thickness="0.5mm" />
    <trace from="C2.pin2" to="net.GND" />

    {/* status LEDs: open-drain outputs pull the cathodes low */}
    <trace from="R4.pin1" to="net.VBUS" thickness="0.5mm" />
    <trace from="R4.pin2" to="D1.anode" />
    <trace from="D1.cathode" to="U1.N_CHRG" />
    <trace from="R5.pin1" to="net.VBUS" thickness="0.5mm" />
    <trace from="R5.pin2" to="D2.anode" />
    <trace from="D2.cathode" to="U1.N_STDBY" />

    {/* battery socket: pin1 = BAT+, pin2 = BAT-, pin3/pin4 are mounting tabs */}
    <trace from="J2.pin1" to="net.VBAT" thickness="0.5mm" />
    <trace from="J2.pin2" to="net.GND" />
    <trace from="J2.pin3" to="net.GND" />
    <trace from="J2.pin4" to="net.GND" />
  </board>
)
