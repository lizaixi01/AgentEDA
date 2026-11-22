import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { BuildStatus } from "@/lib/api"

export const STATUS: Record<string, { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  pass: { label: "检查通过", tone: "text-success border-success/30 bg-success/10", icon: CheckCircle2 },
  warnings: { label: "可制造 · 有警告", tone: "text-warning border-warning/30 bg-warning/10", icon: AlertTriangle },
  errors: { label: "有错误", tone: "text-destructive border-destructive/30 bg-destructive/10", icon: XCircle },
  compile_failed: { label: "编译失败", tone: "text-destructive border-destructive/30 bg-destructive/10", icon: XCircle },
  none: { label: "未构建", tone: "text-muted-foreground", icon: CircleDashed },
}

export function StatusBadge({ status, className }: { status?: BuildStatus | string | null; className?: string }) {
  const s = STATUS[status ?? "none"] ?? STATUS.none
  const Icon = s.icon
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal", s.tone, className)}>
      <Icon className="size-3" />
      {s.label}
    </Badge>
  )
}

/** Labelled meter: a thin progress bar with a "have / total" readout. */
export function Meter({ label, value, total, tone = "bg-brand" }: { label: string; value: number; total: number; tone?: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">
          {value}/{total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all duration-500", tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
