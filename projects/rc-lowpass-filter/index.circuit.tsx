// RC low-pass filter with a simulation testbench.
// Cutoff f = 1 / (2*pi*R*C) = 1 / (2*pi * 1.6k * 100nF) ~ 995 Hz.
// The source and probes exist only for simulation; they are not placed on the PCB.
export default () => (
  <board width="22mm" height="12mm">
    <pinheader name="J1" pinCount={2} pitch="2.54mm" pinLabels={["IN", "GND"]} pcbX={-8} pcbY={0} pcbRotation={90} />
    <pinheader name="J2" pinCount={2} pitch="2.54mm" pinLabels={["OUT", "GND"]} pcbX={8} pcbY={0} pcbRotation={90} />
    <resistor name="R1" resistance="1.6k" footprint="0603" pcbX={-2} pcbY={1.5} />
    <capacitor name="C1" capacitance="100nF" footprint="0603" pcbX={2.5} pcbY={-1} pcbRotation={90} />
    <copperpour connectsTo="net.GND" layer="bottom" />

    <trace from="J1.IN" to="net.VIN" />
    <trace from="R1.pin1" to="net.VIN" />
    <trace from="R1.pin2" to="net.VOUT" />
    <trace from="C1.pin1" to="net.VOUT" />
    <trace from="J2.OUT" to="net.VOUT" />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="J1.GND" to="net.GND" />
    <trace from="J2.GND" to="net.GND" />

    {/* --- testbench: 1 kHz square wave in, watch the filtered output --- */}
    <voltagesource name="V1" waveShape="square" voltage="3.3V" frequency="1kHz" dutyCycle={0.5} />
    <trace from="V1.pin1" to="net.VIN" />
    <trace from="V1.pin2" to="net.GND" />
    <voltageprobe name="VP_IN" connectsTo="J1.IN" />
    <voltageprobe name="VP_OUT" connectsTo="J2.OUT" />
    <analogsimulation duration="4ms" timePerStep="0.01ms" spiceEngine="ngspice" />
  </board>
)
