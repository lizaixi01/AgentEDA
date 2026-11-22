/**
 * Electrical rule checks on the netlist: the mistakes that geometry checks cannot see.
 * Each rule is a conservative heuristic over part kinds and pin names; every finding says
 * when it is safe to ignore.
 */
import type { Diagnostic, NetInfo } from "./analyze"

export interface ErcComponent {
  name: string
  kind: string
  pins: string[]
}

const GROUND_NAME = /^(GND|VSS|AGND|DGND|PGND|GNDA|GNDD)\d*$/i
const POWER_NET_NAME = /^(V[A-Z0-9_]*|VCC\w*|VDD\w*|VBUS|VBAT\w*|VIN|VOUT|\+?\d+V\d*)$/i
/** Pin names that are supply inputs on an IC */
const SUPPLY_PIN = /^(VCC|VDD|VDDIO|VDDA|VDDD|AVDD|DVDD|VCCIO|VIN|VBAT|3V3|V3_3|5V|VS|VM)\d*$/i
const GROUND_PIN = /^(GND|VSS|AGND|DGND|PGND)\d*$/i

export function electricalRules(components: ErcComponent[], nets: NetInfo[]): Diagnostic[] {
  const out: Diagnostic[] = []
  const kindOf = new Map(components.map((c) => [c.name, c.kind]))
  const netOfPin = new Map<string, NetInfo>()
  for (const n of nets) for (const p of n.pins) netOfPin.set(p, n)
  const isGround = (n?: NetInfo) => Boolean(n && (n.isGround || GROUND_NAME.test(n.name)))
  const isPower = (n?: NetInfo) => Boolean(n && !isGround(n) && (n.isPower || POWER_NET_NAME.test(n.name)))
  const connected = (pin: string) => (netOfPin.get(pin)?.pins.length ?? 0) > 1
  const partsOn = (n: NetInfo | undefined, kind: RegExp) =>
    (n?.pins ?? []).map((p) => p.split(".")[0]!).filter((name) => kind.test(kindOf.get(name) ?? ""))
  /** The net on the far side of a two-pin part, seen from `net` */
  const otherSide = (part: string, net: NetInfo) => {
    const comp = components.find((c) => c.name === part)
    if (!comp) return undefined
    return comp.pins.map((p) => netOfPin.get(`${part}.${p}`)).find((n) => n && n !== net)
  }

  for (const c of components) {
    // ---- LED without current limiting ----------------------------------
    if (c.kind === "led") {
      const nets2 = c.pins.map((p) => netOfPin.get(`${c.name}.${p}`)).filter(Boolean) as NetInfo[]
      const wired = c.pins.some((p) => connected(`${c.name}.${p}`))
      // The resistor must be in series with the LED: on a net that is neither a supply rail nor ground.
      if (wired && !nets2.some((n) => !isGround(n) && !n.isPower && partsOn(n, /resistor/).length > 0))
        out.push({
          severity: "warning",
          code: "erc_led_no_resistor",
          message: `${c.name} has no series resistor on either pin.`,
          components: [c.name],
          hint: "Put a resistor in series: R = (V_supply - V_forward) / I, e.g. 1 k for a few mA at 5 V. Ignore only if a constant-current LED driver feeds it.",
        })
    }

    // ---- USB-C sink without CC pull-downs ------------------------------
    // Recognised by signal names (CC1/CC2/VBUS) or by USB-C contact numbers (A5/B5 = CC, A4/A9/B4/B9 = VBUS).
    const ccPins = c.pins.includes("CC1") && c.pins.includes("CC2") ? ["CC1", "CC2"] : c.pins.includes("A5") && c.pins.includes("B5") ? ["A5", "B5"] : null
    const vbusPins = c.pins.filter((p) => /^VBUS/.test(p) || /^(A4|A9|B4|B9)$/.test(p))
    if (ccPins && vbusPins.length) {
      const usesPower = vbusPins.some((p) => connected(`${c.name}.${p}`))
      const missing = ccPins.filter((cc) => {
        const n = netOfPin.get(`${c.name}.${cc}`)
        if (!connected(`${c.name}.${cc}`)) return true
        // Terminated by a resistor, or handed to a controller IC that manages CC itself
        return partsOn(n, /resistor/).length === 0 && partsOn(n, /chip/).length === 0
      })
      if (usesPower && missing.length)
        out.push({
          severity: "warning",
          code: "erc_usb_c_cc",
          message: `${c.name}: ${missing.join(" and ")} ${missing.length > 1 ? "have" : "has"} no pull-down.`,
          components: [c.name],
          hint: "A USB-C device must pull CC1 and CC2 to GND through 5.1 k each (two separate resistors), or USB-C chargers and C-to-C cables supply no power.",
        })
    }

    // ---- IC supply and ground pins ---------------------------------------
    if (c.kind === "chip") {
      const floating = c.pins.filter((p) => (SUPPLY_PIN.test(p) || GROUND_PIN.test(p)) && !connected(`${c.name}.${p}`))
      if (floating.length)
        out.push({
          severity: "error",
          code: "erc_power_pin_unconnected",
          message: `${c.name}: supply pin(s) ${floating.join(", ")} are not connected.`,
          components: [c.name],
          hint: "Wire every supply and ground pin of an IC. If a pin with this name is genuinely optional on this part, connect it as the datasheet says.",
        })

      const bare: string[] = []
      const seen = new Set<NetInfo>()
      for (const p of c.pins.filter((p) => SUPPLY_PIN.test(p))) {
        const n = netOfPin.get(`${c.name}.${p}`)
        if (!n || n.pins.length < 2 || seen.has(n)) continue
        seen.add(n)
        const decoupled = partsOn(n, /capacitor/).some((cap) => isGround(otherSide(cap, n)))
        if (!decoupled) bare.push(`${p} (${n.name})`)
      }
      if (bare.length)
        out.push({
          severity: "warning",
          code: "erc_missing_decoupling",
          message: `${c.name}: no capacitor to ground on ${bare.join(", ")}.`,
          components: [c.name],
          hint: "Add a 100 nF capacitor from each supply rail of the IC to GND, placed within 2-3 mm of the pin (plus the bulk capacitance its datasheet asks for).",
        })
    }
  }

  // ---- I2C bus without pull-ups -------------------------------------------
  const i2c = new Map<NetInfo, string>()
  for (const n of nets) {
    if (n.pins.length < 2) continue
    const role = n.pins.map((p) => p.split(".")[1] ?? "").find((pin) => /^(SDA|SCL)\d*$/i.test(pin)) ?? (/^(I2C_)?(SDA|SCL)\d*$/i.test(n.name) ? n.name : undefined)
    if (role && partsOn(n, /chip/).length > 0) i2c.set(n, role.toUpperCase())
  }
  const noPullup = [...i2c.entries()].filter(([n]) => !partsOn(n, /resistor/).some((r) => isPower(otherSide(r, n))))
  if (noPullup.length)
    out.push({
      severity: "warning",
      code: "erc_i2c_no_pullup",
      message: `I2C line(s) ${noPullup.map(([n, role]) => (n.name.startsWith("N") && /^N\d+$/.test(n.name) ? role : n.name)).join(", ")} have no pull-up resistor to a supply.`,
      hint: "I2C needs one pull-up per line (2.2 k to 10 k, 4.7 k is a good default) somewhere on the bus. Ignore if another board on the same bus provides them.",
    })

  return out
}
