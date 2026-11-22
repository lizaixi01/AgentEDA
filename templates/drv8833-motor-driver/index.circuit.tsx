import { DRV8833PWPR } from "./lib/DRV8833PWPR"
import { XY128V_A_5_08_2P as Terminal } from "./lib/XY128V_A_5_08_2P"

// Dual H-bridge DC motor driver, DRV8833. Motor supply VM: 2.7 V to 10.8 V, up to 1.5 A per bridge.
// AISEN / BISEN tied to GND: no current limiting. nSLEEP and nFAULT pulled up to the chip's
// internal 3.3 V rail (VINT) so the driver is enabled by default; pull SLP low to sleep.
// Motor and supply paths are 0.6 mm wide.
const W = "0.6mm"

export default () => (
  <board width="46mm" height="42mm">
    <DRV8833PWPR name="U1" pcbX={0} pcbY={1} />
    <capacitor name="C1" capacitance="10uF" footprint="0805" pcbX={-6} pcbY={6} />
    <capacitor name="C2" capacitance="100nF" footprint="0402" pcbX={-6.5} pcbY={3} />
    <capacitor name="C3" capacitance="2.2uF" footprint="0603" pcbX={6} pcbY={6} />
    <capacitor name="C4" capacitance="10nF" footprint="0402" pcbX={6.5} pcbY={3} />
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-6.5} pcbY={-1.5} />
    <resistor name="R2" resistance="10k" footprint="0402" pcbX={6.5} pcbY={-1.5} />

    <Terminal name="J1" pcbX={0} pcbY={14.5} />
    <Terminal name="J2" pcbX={-16.5} pcbY={-1} pcbRotation={90} />
    <Terminal name="J3" pcbX={16.5} pcbY={-1} pcbRotation={-90} />
    <pinheader
      name="J4"
      pinCount={7}
      pitch="2.54mm"
      pinLabels={["AIN1", "AIN2", "BIN1", "BIN2", "SLP", "FLT", "GND"]}
      pcbX={0}
      pcbY={-18}
    />
    <copperpour connectsTo="net.GND" layer="bottom" />
    <copperpour connectsTo="net.GND" layer="top" />

    {/* supply */}
    <trace from="J1.pin1" to="net.VM" thickness={W} />
    <trace from="J1.pin2" to="net.GND" thickness={W} />
    <trace from="U1.VM" to="net.VM" thickness={W} />
    <trace from="U1.GND1" to="net.GND" />
    <trace from="U1.GND2" to="net.GND" />
    <trace from="U1.AISEN" to="net.GND" />
    <trace from="U1.BISEN" to="net.GND" />
    <trace from="C1.pin1" to="net.VM" thickness={W} />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="C2.pin1" to="net.VM" thickness={W} />
    <trace from="C2.pin2" to="net.GND" />
    <trace from="U1.VINT" to="net.VINT" />
    <trace from="C3.pin1" to="net.VINT" />
    <trace from="C3.pin2" to="net.GND" />
    <trace from="U1.VCP" to="C4.pin1" />
    <trace from="C4.pin2" to="net.VM" thickness={W} />

    {/* motors */}
    <trace from="U1.AOUT1" to="J2.pin1" thickness={W} />
    <trace from="U1.AOUT2" to="J2.pin2" thickness={W} />
    <trace from="U1.BOUT1" to="J3.pin1" thickness={W} />
    <trace from="U1.BOUT2" to="J3.pin2" thickness={W} />

    {/* control */}
    <trace from="U1.AIN1" to="J4.AIN1" />
    <trace from="U1.AIN2" to="J4.AIN2" />
    <trace from="U1.BIN1" to="J4.BIN1" />
    <trace from="U1.BIN2" to="J4.BIN2" />
    <trace from="U1.nSleep" to="net.SLP" />
    <trace from="J4.SLP" to="net.SLP" />
    <trace from="R1.pin1" to="net.SLP" />
    <trace from="R1.pin2" to="net.VINT" />
    <trace from="U1.nFault" to="net.FLT" />
    <trace from="J4.FLT" to="net.FLT" />
    <trace from="R2.pin1" to="net.FLT" />
    <trace from="R2.pin2" to="net.VINT" />
    <trace from="J4.GND" to="net.GND" />
  </board>
)
