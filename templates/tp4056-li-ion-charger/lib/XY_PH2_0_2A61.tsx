import type { ChipProps } from "@tscircuit/props"

const pinLabels = {
  pin1: ["pin1"],
  pin2: ["pin2"],
  pin3: ["pin3"],
  pin4: ["pin4"]
} as const

export const XY_PH2_0_2A61 = (props: ChipProps<typeof pinLabels>) => {
  return (
    <chip
      pinLabels={pinLabels}
      supplierPartNumbers={{
  "jlcpcb": [
    "C19272095"
  ]
}}
      manufacturerPartNumber="XY-PH2.0-2A61"
      footprint={<footprint>
        <smtpad portHints={["pin4"]} pcbX="-3.299968mm" pcbY="-2.75002625mm" width="1.1999976mm" height="3.999992mm" shape="rect" />
<smtpad portHints={["pin2"]} pcbX="0.999998mm" pcbY="3.00002575mm" width="1.1999976mm" height="3.499993mm" shape="rect" />
<smtpad portHints={["pin1"]} pcbX="-0.999998mm" pcbY="2.99977175mm" width="1.1999976mm" height="3.499993mm" shape="rect" />
<smtpad portHints={["pin3"]} pcbX="3.299968mm" pcbY="-2.75002625mm" width="1.1999976mm" height="3.999992mm" shape="rect" />
<silkscreenpath route={[{"x":-2.500096600000006,"y":-4.350073850000058},{"x":2.499918800000046,"y":-4.350073850000058}]} />
<silkscreenpath route={[{"x":3.9748713999999836,"y":3.199923750000039},{"x":3.9748713999999836,"y":-0.5000688500000479}]} />
<silkscreenpath route={[{"x":1.7998693999999205,"y":1.6498887500000592},{"x":3.127857600000084,"y":1.6498887500000592}]} />
<silkscreenpath route={[{"x":3.127781400000117,"y":1.6498887500000592},{"x":3.127857600000084,"y":3.199923750000039}]} />
<silkscreenpath route={[{"x":3.127781400000117,"y":3.199923750000039},{"x":3.9748713999999836,"y":3.199923750000039}]} />
<silkscreenpath route={[{"x":-3.975099999999884,"y":3.199923750000039},{"x":-3.973982400000068,"y":3.1812547499999937},{"x":-3.975099999999884,"y":-0.5000688500000479}]} />
<silkscreenpath route={[{"x":-3.975099999999884,"y":3.199923750000039},{"x":-3.128086200000098,"y":3.199923750000039},{"x":-3.128086200000098,"y":1.6498887500000592}]} />
<silkscreenpath route={[{"x":-0.200075800000036,"y":1.6498887500000592},{"x":0.19989799999996194,"y":1.6498887500000592}]} />
<silkscreenpath route={[{"x":-3.128086200000098,"y":1.6498887500000592},{"x":-1.8000980000000482,"y":1.6498887500000592}]} />
<silkscreencircle pcbX="-2.23901mm" pcbY="3.19763775mm" radius="0.179578mm" />
<silkscreentext text="{NAME}" pcbX="-0.0127mm" pcbY="5.74932375mm" anchorAlignment="center" fontSize="1mm" />
<courtyardoutline outline={[{"x":-4.230002199999944,"y":5.000022250000029},{"x":4.230002200000058,"y":5.000022250000029},{"x":4.230002200000058,"y":-5.000022250000029},{"x":-4.230002199999944,"y":-5.000022250000029},{"x":-4.230002199999944,"y":5.000022250000029}]} />
      </footprint>}
      cadModel={{
        objUrl: "https://modelcdn.tscircuit.com/easyeda_models/assets/C19272095.obj?uuid=4351acde4eb945fbbcc3428164c16215",
        stepUrl: "https://modelcdn.tscircuit.com/easyeda_models/assets/C19272095.step?uuid=4351acde4eb945fbbcc3428164c16215",
        pcbRotationOffset: 0,
        modelOriginPosition: { x: 0.004999999999886207, y: -0.5549974499999053, z: -0.12 },
      }}
      {...props}
    />
  )
}