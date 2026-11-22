import { useState } from "react"
import { AlertTriangle, CheckCircle2, ChevronRight, Info, Lightbulb, Wand2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { DfmRule, Diagnostic, Report } from "@/lib/api"
import { Meter } from "./status"

/** Chinese titles and advice for known diagnostic codes; the original message stays visible underneath. */
const ZH: [RegExp, string, string?][] = [
  [/^compile_import/, "代码无法加载", "语法错误、导入路径不对或缺少默认导出。按报错的行号修改后重新构建。"],
  [/^compile_render/, "电路渲染出错", "多半是属性写错（单位、枚举值）或连线指向了不存在的引脚。"],
  [/^compile_timeout/, "构建超时", "布线器可能卡住了：放大板子、降低密度或拆分设计。"],
  [/^compile_/, "编译失败"],
  [/outside_board/, "器件超出板框", "把器件往里移，或放大板子。报错信息里给了需要移动的距离和方向。"],
  [/autorouting/, "自动布线未完成", "空间不够或被摆放错误挡住：先修上面的摆放错误，再放大板子、拉开器件间距。"],
  [/^unrouted_connections/, "有连接没有布通", "通常是上一条错误的连带结果，先修那一条。"],
  [/overlap|courtyard/, "器件重叠", "给器件指定 pcbX / pcbY，或放大板子留出空间。"],
  [/source_trace_not_connected|port.*not.*found/, "连线指向了不存在的引脚", "检查引脚名。可在构建报告的器件列表里看到每个器件真实的引脚名。"],
  [/misconfigured/, "器件极性与立创料号不一致", "这样贴出来的二极管 / LED 会反向。用 import_part 导入具体料号，或换用已验证的 C2286（红）/ C2290（白）。"],
  [/^invalid_value/, "数值无法解析", "写成 \"10k\"、\"100nF\"、\"10uH\"、\"16MHz\" 这样的形式。"],
  [/^no_board/, "缺少板框", "用 <board width=\"..mm\" height=\"..mm\"> 把所有内容包起来。"],
  [/^dfm_/, "超出工厂工艺能力", "调大对应尺寸（线宽、过孔、焊环），或换用孔更大的器件。"],
  [/clearance|spacing|short|trace_error/, "铜皮间距不足或短路", "把相关器件拉开一些，重新构建会自动重新布线。"],
  [/^unconnected_pins/, "有引脚没有连接", "如果是有意留空（没用到的 GPIO、连接器的备用脚）可以忽略；电源、地、使能、复位脚不能悬空。"],
  [/^bom_part_not_sourced/, "器件没有立创料号", "嘉立创贴片时不会焊这个器件。用器件搜索找到料号后写进 supplierPartNumbers，或用 import_part 导入。手焊的排针可以不管。"],
  [/^bom_low_stock/, "器件库存偏低", "换一个库存充足的等效料，优先选基础库。"],
  [/^power_trace_thin/, "电源走线是信号线宽", "电流小于约 0.3A 时没问题。电流更大时给该电源网络的每条连线加 thickness=\"0.5mm\"（约每安培 0.4mm）。"],
  [/^erc_led_no_resistor/, "LED 没有限流电阻", "串一个电阻：R = (电源电压 - LED 压降) / 电流，例如 5V 下几毫安用 1kΩ。只有用恒流驱动芯片时可以忽略。"],
  [/^erc_usb_c_cc/, "USB-C 的 CC 脚没有下拉", "USB-C 受电设备必须把 CC1、CC2 各用一颗 5.1kΩ 电阻接地，否则 C 口充电器和 C-C 线不会供电。"],
  [/^erc_power_pin_unconnected/, "芯片的电源或地引脚没有连接", "芯片的每个电源脚和地脚都要接。"],
  [/^erc_missing_decoupling/, "芯片电源没有去耦电容", "每路电源对地加一颗 100nF 电容，放在引脚 2-3mm 以内。"],
  [/^erc_i2c_no_pullup/, "I2C 总线没有上拉电阻", "SDA、SCL 各需要一颗上拉（4.7kΩ 是常用值）。如果总线上别的板子已经提供，可以忽略。"],
  [/^pcb_trace_warning/, "走线比要求的细", "细间距芯片引脚处走线会自动收窄，属于正常现象；其余路段仍是加粗的。"],
  [/^simulation_no_result/, "仿真没有产生结果", "常见原因：没有探针、信号源创建失败、两个电压源串联或并联、某个节点没有到地的直流通路。"],
  [/part_not_found/, "这个料号在目录里没有可用封装", "换一个料号，或者去掉 supplierPartNumbers 让阻容自动匹配。"],
  [/^silkscreen_overlap/, "丝印位号被遮挡", "不影响电气，但装配和调试时看不清位号。把相关器件拉开一些或旋转其中一个。"],
  [/^layout_open/, "网络的铜皮没有真正连通", "独立几何复核发现的：这些引脚在网表里属于同一网络，但铜皮没有接在一起。把相关器件靠近一些或留出布线空间后重新构建。"],
  [/^supplier_footprint_wrong_package/, "封装与所选料号不匹配", "画的焊盘与该料号真实焊盘的重合不到一半，这个料焊不上去。用 import_part 导入准确封装，或换一个该封装的料号。"],
  [/^short_circuit/, "不同网络的铜皮短路", "独立几何复核发现的。把该位置附近的器件拉开约 1mm 后重新构建。"],
  [/^copper_spacing/, "不同网络的铜皮间距小于工艺极限", "独立几何复核发现的。把该位置附近的器件拉开一些后重新构建。"],
  [/^copper_pour_empty/, "铺铜没有生成", "铺铜所在的层上没有同网络的焊盘或过孔。全贴片的板子把铺铜放在顶层。"],
  [/connector.*orientation/, "连接器朝向不对", "接口应该朝向板外。调整 pcbRotation 让插口对着板边。"],
  [/footprint_mismatch/, "封装与料号的推荐焊盘略有差异", "通用阻容感可以忽略；芯片请用 import_part 导入准确封装。"],
  [/missing_manufacturer_part_number|pins_underspecified|no_power_pin|no_ground_pin/, "器件信息不完整（不影响制造）"],
  [/unnamed_trace|missing_sheet|styling|trace_style/, "风格建议（不影响制造）"],
  [/render_failed/, "预览图渲染失败"],
]

function zh(d: Diagnostic): { title?: string; hint?: string } {
  const hit = ZH.find(([re]) => re.test(d.code))
  return hit ? { title: hit[1], hint: hit[2] } : {}
}

function Row({ d, onFix }: { d: Diagnostic; onFix?: (d: Diagnostic) => void }) {
  const t = zh(d)
  const Icon = d.severity === "error" ? XCircle : d.severity === "warning" ? AlertTriangle : Info
  const tone = d.severity === "error" ? "text-destructive" : d.severity === "warning" ? "text-warning" : "text-muted-foreground"
  return (
    <li className="flex gap-3 border-b px-4 py-3 last:border-b-0">
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{d.code}</code>
          {d.components?.map((c) => (
            <Badge key={c} variant="secondary" className="h-5 px-1.5 font-mono text-[11px]">
              {c}
            </Badge>
          ))}
          {d.at && (
            <span className="font-mono text-[11px] text-muted-foreground">
              ({d.at.x}, {d.at.y}) mm
            </span>
          )}
        </div>
        {t.title && <p className="text-sm font-medium">{t.title}</p>}
        <p className={cn("leading-relaxed break-words", t.title ? "text-xs text-muted-foreground" : "text-sm")}>{d.message}</p>
        {onFix && d.severity !== "info" && (
          <Button variant="outline" size="xs" className="float-right ml-2" onClick={() => onFix(d)}>
            <Wand2 />
            让 Agent 修复
          </Button>
        )}
        {(t.hint ?? d.hint) && (
          <p className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-copper" />
            <span>{t.hint ?? d.hint}</span>
          </p>
        )}
      </div>
    </li>
  )
}

function Group({
  title,
  items,
  defaultOpen,
  tone,
  onFix,
}: {
  title: string
  items: Diagnostic[]
  defaultOpen?: boolean
  tone: string
  onFix?: (d: Diagnostic) => void
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  if (!items.length) return null
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <button
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium hover:bg-muted/50"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span>{title}</span>
        <span className={cn("ml-auto rounded-full px-2 py-0.5 font-mono text-xs tabular-nums", tone)}>{items.length}</span>
      </button>
      {open && <ul className="border-t">{items.map((d, i) => <Row key={`${d.code}-${i}`} d={d} onFix={onFix} />)}</ul>}
    </section>
  )
}

export function ChecksPanel({ report, onFix }: { report: Report | null; onFix?: (d: Diagnostic) => void }) {
  if (!report)
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">还没有构建结果。构建后这里会列出电气与设计规则检查。</div>
  const s = report.summary
  const clean = report.errors.length === 0 && report.warnings.length === 0
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border bg-card p-4 sm:grid-cols-4">
          <Meter label="连接已布线" value={s.connectionsRouted} total={s.connectionsTotal} tone={s.connectionsRouted === s.connectionsTotal ? "bg-success" : "bg-warning"} />
          <Meter label="BOM 已匹配立创料号" value={s.bomSourced} total={s.bomLines} tone={s.bomSourced === s.bomLines ? "bg-success" : "bg-warning"} />
          <Stat label="错误" value={s.errors} tone={s.errors ? "text-destructive" : "text-success"} />
          <Stat label="警告" value={s.warnings} tone={s.warnings ? "text-warning" : "text-success"} />
        </div>

        {clean && (
          <div className="flex items-center gap-3 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm">
            <CheckCircle2 className="size-5 text-success" />
            <div>
              <div className="font-medium">所有自动检查通过</div>
              <div className="text-xs text-muted-foreground">自动检查覆盖连通性和几何规则，不验证电路功能是否正确，下单前请人工复核关键电路。</div>
            </div>
          </div>
        )}

        <Group title="错误（必须修复）" items={report.errors} defaultOpen tone="bg-destructive/15 text-destructive" onFix={onFix} />
        <Group title="警告" items={report.warnings} defaultOpen tone="bg-warning/15 text-warning" onFix={onFix} />
        {report.dfm && <Dfm rules={report.dfm.rules} />}
        <Group title="提示" items={report.info} tone="bg-muted text-muted-foreground" />
      </div>
    </div>
  )
}

const DFM_LABEL: Record<string, string> = {
  trace_width: "走线宽度",
  copper_spacing: "不同网络铜皮间距（独立复核）",
  via_hole: "过孔钻孔",
  via_pad: "过孔焊盘直径",
  via_annular: "过孔焊环",
  plated_hole: "金属化孔钻孔",
  pth_annular: "金属化孔焊环",
  npth: "非金属化孔",
  silk_width: "丝印线宽",
  silk_text: "丝印字高",
}

/** Board minimums against the fab's limits: each row shows how much margin is left. */
function Dfm({ rules }: { rules: DfmRule[] }) {
  const shown = rules.filter((r) => r.status !== "n/a")
  if (!shown.length) return null
  const blockingFails = shown.filter((r) => r.status === "fail" && r.blocking).length
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
        可制造性 · 嘉立创双层板工艺
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-xs",
            blockingFails ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success",
          )}
        >
          {blockingFails ? `${blockingFails} 项超出工艺` : "在工艺范围内"}
        </span>
      </div>
      <ul>
        {shown.map((r) => {
          const measured = r.measured ?? 0
          // Bar: the limit sits at 40% of the track, so margin above it is visible.
          const pct = Math.max(4, Math.min(100, (measured / r.limit) * 40))
          const tone =
            r.status === "pass" ? "bg-success" : r.status === "marginal" ? "bg-warning" : r.blocking ? "bg-destructive" : "bg-muted-foreground"
          return (
            <li key={r.id} className="grid grid-cols-[13rem_1fr_auto] items-center gap-3 border-b px-4 py-2 text-sm last:border-b-0">
              <span className="truncate">{DFM_LABEL[r.id] ?? r.label}</span>
              <div className="relative h-1.5 rounded-full bg-muted">
                <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
                <span className="absolute top-1/2 left-[40%] h-3 w-px -translate-y-1/2 bg-foreground/50" title={`工艺极限 ${r.limit} mm`} />
              </div>
              <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
                <span className={cn(r.status === "fail" && r.blocking && "text-destructive")}>{measured} mm</span>
                <span className="text-muted-foreground">≥ {r.limit}</span>
                <span
                  className={cn(
                    "w-12 rounded px-1 py-0.5 text-center font-sans text-[11px]",
                    r.status === "pass" && "bg-success/15 text-success",
                    r.status === "marginal" && "bg-warning/15 text-warning",
                    r.status === "fail" && (r.blocking ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"),
                  )}
                >
                  {r.status === "pass" ? "通过" : r.status === "marginal" ? "临界" : r.blocking ? "超限" : "偏细"}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">
        竖线是工艺极限。“偏细”的丝印不影响电气，工厂会加粗或忽略，但文字可能看不清。极限值取自嘉立创官网工艺能力页，下单前以官网为准。
      </p>
    </section>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-2xl leading-tight font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  )
}
