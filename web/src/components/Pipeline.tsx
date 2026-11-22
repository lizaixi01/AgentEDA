import { Check, Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { BuildProgress, ProjectState } from "@/lib/api"

type StepState = "done" | "active" | "failed" | "todo"

/**
 * The five stages every board goes through, derived from project state:
 * design written -> placed & routed -> checks pass -> BOM sourced -> fab files exported.
 */
export function Pipeline({ state, progress, building }: { state: ProjectState; progress: BuildProgress | null; building: boolean }) {
  const r = state.report
  const s = r?.summary
  const compiled = Boolean(r && r.status !== "compile_failed")
  const routed = Boolean(s && s.connectionsTotal > 0 && s.connectionsRouted === s.connectionsTotal)
  const checksOk = Boolean(r && r.ok)
  const sourced = Boolean(s && s.bomLines > 0 && s.bomSourced === s.bomLines)
  const exported = state.fab.length > 0 && checksOk

  const steps: { key: string; label: string; detail: string; state: StepState }[] = [
    {
      key: "design",
      label: "设计",
      detail: r ? (compiled ? `${s!.components} 个器件 · ${s!.nets} 个网络` : "编译失败") : "等待设计",
      state: !r ? "todo" : compiled ? "done" : "failed",
    },
    {
      key: "route",
      label: "布局布线",
      detail: s && compiled ? `${s.connectionsRouted}/${s.connectionsTotal} 条连接` : "—",
      state: !compiled ? "todo" : routed ? "done" : "failed",
    },
    {
      key: "check",
      label: "规则检查",
      detail: r && compiled ? (r.errors.length ? `${r.errors.length} 个错误` : r.warnings.length ? `通过 · ${r.warnings.length} 个警告` : "全部通过") : "—",
      state: !compiled ? "todo" : checksOk ? "done" : "failed",
    },
    {
      key: "bom",
      label: "物料匹配",
      detail: s && compiled ? `${s.bomSourced}/${s.bomLines} 已匹配` : "—",
      state: !compiled ? "todo" : sourced ? "done" : "active",
    },
    {
      key: "fab",
      label: "制造文件",
      detail: exported ? "已导出" : checksOk ? "可以导出" : "—",
      state: exported ? "done" : "todo",
    },
  ]

  // While building, the stage in flight is highlighted instead.
  if (building) {
    const stage = progress?.stage ?? "compile"
    const activeIndex = stage === "compile" ? 1 : stage === "analyze" ? 2 : 3
    steps.forEach((st, i) => {
      if (i < activeIndex && i === 0) st.state = "done"
      else if (i === activeIndex || (stage === "compile" && i === 0)) st.state = "active"
      else if (i > activeIndex) st.state = "todo"
    })
    steps[0].detail = "编译中"
  }

  return (
    <ol className="flex items-stretch gap-1 overflow-x-auto" aria-label="设计进度">
      {steps.map((st, i) => (
        <li key={st.key} className="flex min-w-[7.5rem] flex-1 items-center gap-1">
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors",
              st.state === "done" && "border-success/25 bg-success/5",
              st.state === "active" && "border-brand/40 bg-brand/10",
              st.state === "failed" && "border-destructive/30 bg-destructive/5",
              st.state === "todo" && "border-dashed opacity-60",
            )}
          >
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px]",
                st.state === "done" && "bg-success text-background",
                st.state === "active" && "bg-brand text-brand-foreground",
                st.state === "failed" && "bg-destructive text-white",
                st.state === "todo" && "bg-muted text-muted-foreground",
              )}
            >
              {st.state === "done" ? (
                <Check className="size-3" strokeWidth={3} />
              ) : st.state === "failed" ? (
                <X className="size-3" strokeWidth={3} />
              ) : st.state === "active" && building ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                i + 1
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs leading-tight font-medium">{st.label}</span>
              <span className="block truncate text-[11px] leading-tight text-muted-foreground">{st.detail}</span>
            </span>
          </div>
          {i < steps.length - 1 && <span className={cn("h-px w-2 shrink-0", st.state === "done" ? "bg-success/50" : "bg-border")} />}
        </li>
      ))}
    </ol>
  )
}
