// NE555 astable blinker. f = 1.44 / ((R1 + 2*R2) * C1) = 1.44 / (210k * 4.7uF) ~ 1.46 Hz.
// LED current ~ (5 V - 1.5 V drop at OUT - 2 V) / 330 = ~5 mA.
export default () => (
  <board width="24mm" height="18mm">
    <chip
      name="U1"
      footprint="soic8"
      manufacturerPartNumber="NE555DR"
      supplierPartNumbers={{ jlcpcb: ["C7593"] }}
      pinLabels={{ pin1: "GND", pin2: "TRIG", pin3: "OUT", pin4: "RESET", pin5: "CTRL", pin6: "THRES", pin7: "DISCH", pin8: "VCC" }}
      pinAttributes={{ VCC: { requiresPower: true }, GND: { requiresGround: true } }}
      pcbX={0}
      pcbY={0}
    />
    <resistor name="R1" resistance="10k" footprint="0603" />
    <resistor name="R2" resistance="100k" footprint="0603" />
    <capacitor name="C1" capacitance="4.7uF" footprint="0603" />
    <capacitor name="C2" capacitance="10nF" footprint="0603" />
    <capacitor name="C3" capacitance="100nF" footprint="0603" />
    <resistor name="R3" resistance="330" footprint="0603" />
    <led name="D1" color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} />
    <pinheader name="J1" pinCount={2} pitch="2.54mm" pinLabels={["V5", "GND"]} pcbX={-9.5} pcbY={0} pcbRotation={90} />

    <copperpour connectsTo="net.GND" layer="bottom" />

    <trace from="J1.V5" to="net.V5" />
    <trace from="J1.GND" to="net.GND" />
    <trace from="U1.VCC" to="net.V5" />
    <trace from="U1.RESET" to="net.V5" />
    <trace from="U1.GND" to="net.GND" />
    <trace from="C3.pin1" to="net.V5" />
    <trace from="C3.pin2" to="net.GND" />

    <trace from="R1.pin1" to="net.V5" />
    <trace from="R1.pin2" to="net.DISCH" />
    <trace from="U1.DISCH" to="net.DISCH" />
    <trace from="R2.pin1" to="net.DISCH" />
    <trace from="R2.pin2" to="net.TIMING" />
    <trace from="U1.THRES" to="net.TIMING" />
    <trace from="U1.TRIG" to="net.TIMING" />
    <trace from="C1.pin1" to="net.TIMING" />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="U1.CTRL" to="C2.pin1" />
    <trace from="C2.pin2" to="net.GND" />

    <trace from="U1.OUT" to="R3.pin1" />
    <trace from="R3.pin2" to="D1.anode" />
    <trace from="D1.cathode" to="net.GND" />
  </board>
)
