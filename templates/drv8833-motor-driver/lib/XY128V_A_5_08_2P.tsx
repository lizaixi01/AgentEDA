import type { ChipProps } from "@tscircuit/props"

const pinLabels = {
  pin1: ["pin1"],
  pin2: ["pin2"]
} as const

export const XY128V_A_5_08_2P = (props: ChipProps<typeof pinLabels>) => {
  return (
    <chip
      pinLabels={pinLabels}
      supplierPartNumbers={{
  "jlcpcb": [
    "C557665"
  ]
}}
      manufacturerPartNumber="XY128V-A-5.08-2P"
      footprint={<footprint>
        <platedhole  portHints={["pin1"]} pcbX="-2.54mm" pcbY="0mm" outerDiameter="2.1999956mm" holeDiameter="1.3999972mm" shape="circle" />
<platedhole  portHints={["pin2"]} pcbX="2.54mm" pcbY="0mm" outerDiameter="2.1999956mm" holeDiameter="1.3999972mm" shape="circle" />
<silkscreenpath route={[{"x":-5.080127000000061,"y":5.1999896000000945},{"x":-5.080127000000061,"y":-5.100015199999916}]} />
<silkscreenpath route={[{"x":5.079872999999907,"y":5.1999896000000945},{"x":5.079872999999907,"y":-5.100040600000057}]} />
<silkscreenpath route={[{"x":-5.080127000000061,"y":5.1999896000000945},{"x":5.079872999999907,"y":5.1999896000000945}]} />
<silkscreenpath route={[{"x":-5.080127000000061,"y":-4.444999999999936},{"x":5.079872999999907,"y":-4.444999999999936}]} />
<silkscreenpath route={[{"x":-5.080127000000061,"y":-2.768828600000006},{"x":5.079872999999907,"y":-2.768828600000006}]} />
<silkscreenpath route={[{"x":-5.080127000000061,"y":3.225596800000062},{"x":5.079872999999907,"y":3.225596800000062}]} />
<silkscreenpath route={[{"x":-5.080127000000061,"y":-5.100040600000057},{"x":5.079872999999907,"y":-5.100040600000057}]} />
<silkscreentext text="{NAME}" pcbX="-0.294132mm" pcbY="6.207mm" anchorAlignment="center" fontSize="1mm" />
<courtyardoutline outline={[{"x":-5.930125799999928,"y":5.446992399999999},{"x":5.329872999999907,"y":5.446992399999999},{"x":5.329872999999907,"y":-5.352986999999985},{"x":-5.930125799999928,"y":-5.352986999999985},{"x":-5.930125799999928,"y":5.446992399999999}]} />
      </footprint>}
      cadModel={{
        objUrl: "https://modelcdn.tscircuit.com/easyeda_models/assets/C557665.obj?uuid=50b8e33f129842a6b2beea94f75264f8",
        stepUrl: "https://modelcdn.tscircuit.com/easyeda_models/assets/C557665.step?uuid=50b8e33f129842a6b2beea94f75264f8",
        pcbRotationOffset: 0,
        modelOriginPosition: { x: 0.00012640000006758356, y: -0.004562700000007247, z: -7.050007000000001 },
      }}
      {...props}
    />
  )
}