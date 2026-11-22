import { useState } from "react"
import { AlertTriangle, Download, ExternalLink, Factory, FileArchive, FileSpreadsheet, FileText, Loader2, PackageCheck } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { api, formatBytes, type GerberVerification, type ProjectState } from "@/lib/api"
import { cn } from "@/lib/utils"

const DESCRIBE: [RegExp, string, typeof FileText][] = [
  [/-fab\.zip$/, "全部文件打包", FileArchive],
  [/^gerbers\.zip$/, "Gerber + 钻孔文件，上传到嘉立创作为 PCB 文件", FileArchive],
  [/^bom\.csv$/, "物料清单，SMT 贴片用", FileSpreadsheet],
  [/^cpl\.csv$/, "贴片坐标文件，SMT 贴片用", FileSpreadsheet],
  [/\.step$/, "3D STEP 模型，可导入机械 CAD 设计外壳", FileText],
  [/\.kicad_pcb$/, "KiCad PCB，可在 KiCad 中继续编辑", FileText],
  [/\.kicad_sch$/, "KiCad 原理图", FileText],
  [/^circuit\.json$/, "Circuit JSON 中间格式", FileText],
]
const ORDER = ["-fab.zip", "gerbers.zip", "bom.csv", "cpl.csv", ".step", ".kicad_pcb", ".kicad_sch", "circuit.json"]
const rank = (name: string) => {
  const i = ORDER.findIndex((o) => name.endsWith(o))
  return i === -1 ? 99 : i
}

const LAYER_NAME: Record<string, string> = {
  copper: "铜层",
  soldermask: "阻焊",
  silkscreen: "丝印",
  solderpaste: "钢网",
  outline: "板框",
  drill: "钻孔",
}
const SIDE_NAME: Record<string, string> = { top: "顶", bottom: "底", all: "" }

/**
 * The exported Gerbers, parsed back by an independent renderer: proof that the files are
 * well-formed and complete, and a picture of what the fab will actually make.
 */
function GerberCheck({ id, v, stamp }: { id: string; v: GerberVerification; stamp: number }) {
  const [side, setSide] = useState<"top" | "bottom">("top")
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
        Gerber 回读校验
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-normal", v.ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive")}>
          {v.ok ? "通过" : "未通过"}
        </span>
        <span className="flex-1" />
        {v.previews.length > 0 && (
          <div className="flex rounded-lg border p-0.5 text-xs font-normal">
            {(["top", "bottom"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={cn("rounded-md px-2.5 py-1", side === s ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
                aria-pressed={side === s}
              >
                {s === "top" ? "顶面" : "底面"}
              </button>
            ))}
          </div>
        )}
      </div>
      {v.previews.length > 0 && (
        <div className="flex h-80 items-center justify-center bg-neutral-900 p-4">
          <img
            src={api.artifactUrl(id, `fab-preview/${side}.svg`, stamp)}
            alt={`由 Gerber 文件渲染的${side === "top" ? "顶面" : "底面"}预览`}
            className="h-full w-full object-contain"
          />
        </div>
      )}
      <div className="space-y-2 border-t px-4 py-3 text-sm">
        <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-3">
          <Check ok={v.missing.length === 0} label={v.missing.length === 0 ? `必需图层齐全（共 ${v.layers.length} 个文件）` : `缺少图层：${v.missing.join("、")}`} />
          <Check
            ok={v.sizeMatchesDesign !== false}
            label={v.sizeMm ? `板框 ${v.sizeMm.width} × ${v.sizeMm.height} mm${v.sizeMatchesDesign ? "，与设计一致" : "，与设计不一致"}` : "未能读出板框尺寸"}
          />
          <Check ok={!v.note} label={v.note ? "文件解析出错" : "全部文件可被第三方解析器解析"} />
        </ul>
        <div className="flex flex-wrap gap-1">
          {v.layers.map((l) => (
            <span key={l.file} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" title={l.file}>
              {l.type ? `${SIDE_NAME[l.side ?? "all"] ?? ""}${LAYER_NAME[l.type] ?? l.type}` : "未识别"} · {l.file.split(".").pop()}
            </span>
          ))}
        </div>
        {v.note && <p className="text-xs text-destructive">{v.note}</p>}
        <p className="text-xs text-muted-foreground">
          上图不是设计稿，而是把导出的 Gerber 文件用独立解析器（{v.parser}）重新读回后渲染的结果，等同于工厂看到的内容。
        </p>
      </div>
    </section>
  )
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-start gap-1.5 text-xs">
      {ok ? <PackageCheck className="mt-0.5 size-3.5 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
      <span>{label}</span>
    </li>
  )
}

export function FabPanel({ state, onExported }: { state: ProjectState; onExported: () => void }) {
  const [busy, setBusy] = useState(false)
  const [reporting, setReporting] = useState(false)
  const report = state.report
  const id = state.meta.id
  const hasErrors = Boolean(report && report.errors.length > 0)
  const canExport = Boolean(report && report.status !== "compile_failed")
  const b = report?.summary.board
  const unsourced = report?.bom.filter((l) => !l.sourced).flatMap((l) => l.designators) ?? []

  const run = async (force = false) => {
    setBusy(true)
    try {
      const r = await api.exportFab(id, force)
      toast.success(`已生成 ${r.files.length} 个制造文件`)
      onExported()
    } catch (e: any) {
      toast.error(e.message, { description: e.hint })
    } finally {
      setBusy(false)
    }
  }

  const files = [...state.fab].sort((a, c) => rank(a.name) - rank(c.name))

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-5">
        <section className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand">
              <Factory className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">制造文件</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {b ? `${b.widthMm} × ${b.heightMm} mm · ${b.layers} 层 · 板厚 ${b.thicknessMm} mm · ${report!.summary.components} 个器件` : "先完成一次成功构建，再导出制造文件。"}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={!canExport || reporting}
              onClick={async () => {
                // Open the tab synchronously so the browser does not treat it as a popup, then point it at the report.
                const tab = window.open("about:blank", "_blank")
                setReporting(true)
                try {
                  await api.exportReport(id)
                  if (tab) tab.location.href = api.artifactUrl(id, "report.html", Date.now())
                } catch (e: any) {
                  tab?.close()
                  toast.error(e.message, { description: e.hint })
                } finally {
                  setReporting(false)
                }
              }}
            >
              {reporting ? <Loader2 className="animate-spin" /> : <FileText />}
              设计报告
            </Button>
            <Button onClick={() => run(false)} disabled={busy || !canExport || hasErrors} className="bg-brand text-brand-foreground hover:bg-brand/85">
              {busy ? <Loader2 className="animate-spin" /> : <PackageCheck />}
              {files.length ? "重新导出" : "导出制造文件"}
            </Button>
          </div>

          {hasErrors && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm">
              <AlertTriangle className="size-4 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1">当前设计还有 {report!.errors.length} 个错误，按这些文件生产的板子很可能不能用。请先修复。</span>
              <Button variant="outline" size="sm" disabled={busy || !canExport} onClick={() => run(true)}>
                仍然导出
              </Button>
            </div>
          )}
          {!hasErrors && unsourced.length > 0 && (
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>这些器件没有立创料号，贴片时不会被焊接，需要自己手焊或补料号：{unsourced.join("、")}</span>
            </div>
          )}
        </section>

        {files.length > 0 && state.fabVerification && <GerberCheck id={id} v={state.fabVerification} stamp={files[0]?.bytes ?? 0} />}

        {files.length > 0 && (
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b px-4 py-2.5 text-sm font-medium">文件</div>
            <ul>
              {files.map((f, i) => {
                const [, desc, Icon] = DESCRIBE.find(([re]) => re.test(f.name)) ?? [null, "", FileText]
                return (
                  <li key={f.name} className={cn("flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0", i === 0 && "bg-brand/5")}>
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-sm">{f.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{desc}</div>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">{formatBytes(f.bytes)}</span>
                    <Button
                      variant={i === 0 ? "default" : "outline"}
                      size="sm"
                      render={<a href={api.artifactUrl(id, `fab/${f.name}`) + "?download"} download={f.name} />}
                    >
                      <Download />
                      下载
                    </Button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <section className="rounded-xl border bg-card p-5">
          <h3 className="font-medium">在嘉立创下单</h3>
          <ol className="mt-3 space-y-2.5 text-sm">
            {[
              ["上传 PCB 文件", "打开嘉立创下单页，上传 gerbers.zip，板子尺寸和层数会自动识别。"],
              ["开启 SMT 贴片（可选）", "勾选 PCB Assembly，分别上传 bom.csv 和 cpl.csv。"],
              ["核对后下单", "在贴片预览里核对每个器件的料号、方向和位置，确认无误再付款。"],
            ].map(([title, body], i) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">{i + 1}</span>
                <div>
                  <div className="font-medium">{title}</div>
                  <div className="text-muted-foreground">{body}</div>
                </div>
              </li>
            ))}
          </ol>
          <Button variant="outline" size="sm" className="mt-4" render={<a href="https://cart.jlcpcb.com/quote" target="_blank" rel="noreferrer" />}>
            打开嘉立创下单页
            <ExternalLink />
          </Button>
        </section>
      </div>
    </div>
  )
}
