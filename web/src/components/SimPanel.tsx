import { useMemo, useRef, useState } from "react"
import { Activity } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ProbeStats, Report } from "@/lib/api"

// Categorical slots in fixed order (never cycled); light and dark are separately chosen steps.
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"]

const W = 860
const H = 340
const M = { top: 16, right: 20, bottom: 34, left: 52 }

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    min -= 1
    max += 1
  }
  const span = max - min
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const start = Math.floor(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + step * 0.501; v += step) out.push(Number(v.toPrecision(10)))
  return out
}

const fmtV = (v: number) => (Math.abs(v) < 1e-6 ? "0 V" : Math.abs(v) < 1 ? `${Number((v * 1000).toPrecision(3))} mV` : `${Number(v.toPrecision(3))} V`)
const fmtHz = (f: number | null) => (f === null ? "—" : f >= 1e6 ? `${(f / 1e6).toPrecision(3)} MHz` : f >= 1e3 ? `${(f / 1e3).toPrecision(3)} kHz` : `${f.toPrecision(3)} Hz`)

function Chart({ probes, dark }: { probes: ProbeStats[]; dark: boolean }) {
  const palette = dark ? SERIES_DARK : SERIES_LIGHT
  const svgRef = useRef<SVGSVGElement>(null)
  const [cursor, setCursor] = useState<number | null>(null)

  const { tMin, tMax, yTicks, x, y, tTicks } = useMemo(() => {
    const ts = probes.flatMap((p) => [p.points[0]?.[0] ?? 0, p.points[p.points.length - 1]?.[0] ?? 1])
    const tMin = Math.min(...ts)
    const tMax = Math.max(...ts)
    const yTicks = niceTicks(Math.min(0, ...probes.map((p) => p.minV)), Math.max(...probes.map((p) => p.maxV)))
    const yMin = yTicks[0]
    const yMax = yTicks[yTicks.length - 1]
    const x = (t: number) => M.left + ((t - tMin) / (tMax - tMin || 1)) * (W - M.left - M.right)
    const y = (v: number) => H - M.bottom - ((v - yMin) / (yMax - yMin || 1)) * (H - M.top - M.bottom)
    return { tMin, tMax, yTicks, x, y, tTicks: niceTicks(tMin, tMax, 6).filter((t) => t >= tMin - 1e-9 && t <= tMax + 1e-9) }
  }, [probes])

  // Value of each series at the cursor time (nearest sample).
  const at = (p: ProbeStats, t: number) => {
    let best = p.points[0]
    for (const pt of p.points) if (Math.abs(pt[0] - t) < Math.abs(best[0] - t)) best = pt
    return best
  }

  const onMove = (e: React.PointerEvent) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const t = tMin + ((px - M.left) / (W - M.left - M.right)) * (tMax - tMin)
    setCursor(t < tMin || t > tMax ? null : t)
  }

  const grid = dark ? "#2c2c2a" : "#e1e0d9"
  const ink = dark ? "#c3c2b7" : "#55554f"

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full touch-none"
        role="img"
        aria-label={`仿真波形：${probes.map((p) => p.name).join("、")} 随时间变化的电压`}
        onPointerMove={onMove}
        onPointerLeave={() => setCursor(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} stroke={grid} strokeWidth={1} />
            <text x={M.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill={ink} className="font-mono">
              {Number(v.toPrecision(4))}
            </text>
          </g>
        ))}
        {tTicks.map((t) => (
          <text key={t} x={x(t)} y={H - M.bottom + 16} textAnchor="middle" fontSize={11} fill={ink} className="font-mono">
            {Number(t.toPrecision(4))}
          </text>
        ))}
        <text x={W - M.right} y={H - 4} textAnchor="end" fontSize={11} fill={ink}>
          时间 (ms)
        </text>
        <text x={12} y={M.top + 2} fontSize={11} fill={ink}>
          V
        </text>
        {probes.map((p, i) => (
          <polyline
            key={p.name}
            points={p.points.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={palette[i % palette.length]}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {cursor !== null && (
          <g>
            <line x1={x(cursor)} x2={x(cursor)} y1={M.top} y2={H - M.bottom} stroke={ink} strokeWidth={1} strokeDasharray="3 3" />
            {probes.map((p, i) => {
              const [t, v] = at(p, cursor)
              return <circle key={p.name} cx={x(t)} cy={y(v)} r={4} fill={palette[i % palette.length]} stroke={dark ? "#1a1a19" : "#fcfcfb"} strokeWidth={2} />
            })}
          </g>
        )}
      </svg>
      {cursor !== null && (
        <div
          className="pointer-events-none absolute top-2 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={cursor > (tMin + tMax) / 2 ? { left: M.left + 8 } : { right: M.right + 8 }}
        >
          <div className="mb-1 font-mono text-muted-foreground">{Number(cursor.toPrecision(4))} ms</div>
          {probes.map((p, i) => (
            <div key={p.name} className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: palette[i % palette.length] }} />
              <span>{p.name}</span>
              <span className="ml-auto pl-3 font-mono tabular-nums">{fmtV(at(p, cursor)[1])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function SimPanel({ report, dark }: { report: Report | null; dark: boolean }) {
  const sim = report?.simulation
  if (!sim || sim.probes.length === 0)
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center text-sm text-muted-foreground">
          <Activity className="mx-auto mb-3 size-10 opacity-40" />
          <p className="font-medium text-foreground">这个设计还没有仿真</p>
          <p className="mt-2 leading-relaxed">
            在设计里加入信号源 <code className="rounded bg-muted px-1 font-mono text-xs">&lt;voltagesource&gt;</code>、探针{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">&lt;voltageprobe&gt;</code> 和{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">&lt;analogsimulation&gt;</code>
            ，构建时会自动运行 SPICE 仿真并在这里显示波形。可以直接让 Agent “加一个仿真验证输出”。模板“RC 低通滤波器”里有完整示例。
          </p>
        </div>
      </div>
    )
  const palette = dark ? SERIES_DARK : SERIES_LIGHT
  // Each experiment gets its own chart; one voltage axis per chart.
  const groups = sim.experiments.length ? sim.experiments.map((e) => e.name) : [...new Set(sim.probes.map((p) => p.experiment))]
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-5">
        {groups.map((g) => {
          const probes = sim.probes.filter((p) => p.experiment === g).slice(0, 8)
          if (!probes.length) return null
          const exp = sim.experiments.find((e) => e.name === g)
          return (
            <section key={g} className="overflow-hidden rounded-xl border bg-card">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2.5">
                <span className="text-sm font-medium">瞬态仿真{exp ? ` · ${exp.durationMs} ms` : ""}</span>
                <span className="flex-1" />
                {probes.length > 1 &&
                  probes.map((p, i) => (
                    <span key={p.name} className="flex items-center gap-1.5 text-xs">
                      <span className="h-0.5 w-3 rounded-full" style={{ background: palette[i % palette.length] }} />
                      {p.name}
                    </span>
                  ))}
              </div>
              <div className="p-2">
                <Chart probes={probes} dark={dark} />
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>探针</TableHead>
                    <TableHead className="text-right">最小</TableHead>
                    <TableHead className="text-right">最大</TableHead>
                    <TableHead className="text-right">平均</TableHead>
                    <TableHead className="text-right">峰峰值</TableHead>
                    <TableHead className="text-right" title="后半段的峰峰值，不含上电瞬态">稳态纹波</TableHead>
                    <TableHead className="text-right">频率</TableHead>
                    <TableHead className="text-right">占空比</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {probes.map((p, i) => (
                    <TableRow key={p.name} className="font-mono text-xs tabular-nums">
                      <TableCell className="font-sans text-sm">
                        <span className="mr-2 inline-block size-2 rounded-full" style={{ background: palette[i % palette.length] }} />
                        {p.name}
                      </TableCell>
                      <TableCell className="text-right">{fmtV(p.minV)}</TableCell>
                      <TableCell className="text-right">{fmtV(p.maxV)}</TableCell>
                      <TableCell className="text-right">{fmtV(p.meanV)}</TableCell>
                      <TableCell className="text-right">{fmtV(p.peakToPeakV)}</TableCell>
                      <TableCell className="text-right">{p.settled ? fmtV(p.settled.peakToPeakV) : "—"}</TableCell>
                      <TableCell className="text-right">{fmtHz(p.frequencyHz)}</TableCell>
                      <TableCell className="text-right">{p.dutyCycle === null ? "—" : `${Math.round(p.dutyCycle * 100)}%`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )
        })}
        <p className="text-xs leading-relaxed text-muted-foreground">
          仿真使用 ngspice 和理想器件模型，不含走线寄生参数。没有 SPICE 模型的芯片不参与仿真。结果用于验证电路原理，不代替实测。
        </p>
      </div>
    </div>
  )
}
