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
