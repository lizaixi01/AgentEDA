import { SHT30_DIS_B2_5KS } from "./lib/SHT30_DIS_B2_5KS"

// SHT30 temperature / humidity sensor breakout. I2C address 0x44 (ADDR tied low).
// 4.7k pull-ups on SDA and SCL, 100 nF decoupling at VDD, reset held high through 10k.
// Pin R is reserved and tied to VSS as the datasheet asks. ALERT is left unconnected.
export default () => (
  <board width="16mm" height="14mm">
    <SHT30_DIS_B2_5KS name="U1" pcbX={2} pcbY={2} />
    <capacitor name="C1" capacitance="100nF" footprint="0402" pcbX={2} pcbY={-1.8} />
    <resistor name="R1" resistance="4.7k" footprint="0402" pcbX={-2.5} pcbY={3.5} />
    <resistor name="R2" resistance="4.7k" footprint="0402" pcbX={-2.5} pcbY={1.5} />
    <resistor name="R3" resistance="10k" footprint="0402" pcbX={5.5} pcbY={-1.5} />
    <pinheader name="J1" pinCount={4} pitch="2.54mm" pinLabels={["VCC", "GND", "SCL", "SDA"]} pcbX={0} pcbY={-5} />
    <copperpour connectsTo="net.GND" layer="bottom" />

    <trace from="J1.VCC" to="net.V3_3" thickness="0.3mm" />
    <trace from="J1.GND" to="net.GND" />
    <trace from="J1.SCL" to="net.SCL" />
    <trace from="J1.SDA" to="net.SDA" />

    <trace from="U1.VDD" to="net.V3_3" thickness="0.3mm" />
    <trace from="U1.VSS" to="net.GND" />
    <trace from="U1.EPAD" to="net.GND" />
    <trace from="U1.R" to="net.GND" />
    <trace from="U1.ADDR" to="net.GND" />
    <trace from="U1.SDA" to="net.SDA" />
    <trace from="U1.SCL" to="net.SCL" />
    <trace from="U1.nRESET" to="R3.pin1" />
    <trace from="R3.pin2" to="net.V3_3" thickness="0.3mm" />

    <trace from="C1.pin1" to="net.V3_3" thickness="0.3mm" />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="R1.pin1" to="net.V3_3" thickness="0.3mm" />
    <trace from="R1.pin2" to="net.SDA" />
    <trace from="R2.pin1" to="net.V3_3" thickness="0.3mm" />
    <trace from="R2.pin2" to="net.SCL" />
  </board>
)
