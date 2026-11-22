import { useEffect, useState } from "react"
import { Loader2, Move, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, type ComponentInfo } from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * Floating panel for the part selected on the PCB: shows what it is and lets the user
 * nudge its position. Applying writes pcbX / pcbY / pcbRotation into the design and rebuilds.
 */
export function ComponentInspector({
  project,
  component,
  components,
  busy,
  onSelect,
  onClose,
  onApplied,
}: {
  project: string
  component: ComponentInfo
  components: ComponentInfo[]
  busy: boolean
  onSelect: (name: string) => void
  onClose: () => void
  onApplied: () => void
}) {
  const [x, setX] = useState("")
  const [y, setY] = useState("")
  const [rot, setRot] = useState("")
  const [layer, setLayer] = useState<"top" | "bottom">("top")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setX(String(component.x ?? 0))
    setY(String(component.y ?? 0))
    setRot(String(component.rotation ?? 0))
    setLayer(component.layer === "bottom" ? "bottom" : "top")
    // Depend on the values, not the object: every project refresh hands in a new object.
  }, [component.name, component.x, component.y, component.rotation, component.layer])

  const changed =
    Number(x) !== (component.x ?? 0) || Number(y) !== (component.y ?? 0) || Number(rot) !== (component.rotation ?? 0) || layer !== (component.layer ?? "top")
  const valid = [x, y, rot].every((v) => v.trim() !== "" && Number.isFinite(Number(v)))

  const apply = async () => {
    setSaving(true)
    try {
      await api.place(project, {
        name: component.name,
        ...(Number(x) !== (component.x ?? 0) ? { x: Number(x) } : {}),
        ...(Number(y) !== (component.y ?? 0) ? { y: Number(y) } : {}),
        ...(Number(rot) !== (component.rotation ?? 0) ? { rotation: Number(rot) } : {}),
        ...(layer !== (component.layer ?? "top") ? { layer } : {}),
      })
      onApplied()
    } catch (e: any) {
      toast.error(e.code === "component_not_found" ? "这个器件是用循环或子组件生成的，无法直接拖动，请在代码里修改" : e.message, {
        description: e.code === "component_not_found" ? undefined : e.hint,
      })
    } finally {
      setSaving(false)
    }
  }

  const nudge = (set: (v: string) => void, cur: string, d: number) => set(String(Math.round((Number(cur) + d) * 1000) / 1000))

  return (
    <div className="absolute top-14 right-3 z-10 w-64 rounded-xl border bg-background/95 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Move className="size-3.5 text-muted-foreground" />
        <select
          value={component.name}
          onChange={(e) => onSelect(e.target.value)}
          className="min-w-0 flex-1 truncate bg-transparent font-mono text-sm font-medium outline-none"
          aria-label="选择器件"
        >
          {components.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="关闭">
          <X />
        </Button>
      </div>
      <div className="space-y-2.5 p-3">
        <div className="text-xs leading-relaxed text-muted-foreground">
          <div className="truncate text-sm text-foreground">{component.value || component.mpn || component.kind}</div>
          <div className="truncate font-mono">{[component.footprint, component.lcsc].filter(Boolean).join(" · ") || component.kind}</div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["X (mm)", x, setX, 0.5],
              ["Y (mm)", y, setY, 0.5],
              ["角度 (°)", rot, setRot, 90],
            ] as const
          ).map(([label, value, set, step]) => (
            <label key={label} className="block text-[11px] text-muted-foreground">
              {label}
              <Input
                value={value}
                onChange={(e) => set(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault()
                    nudge(set, value, step)
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault()
                    nudge(set, value, -step)
                  } else if (e.key === "Enter" && changed && valid) void apply()
                }}
                inputMode="decimal"
                className="mt-1 h-7 px-2 font-mono text-xs"
              />
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-0.5 text-xs">
            {(["top", "bottom"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLayer(l)}
                aria-pressed={layer === l}
                className={cn("rounded-md px-2 py-0.5", layer === l ? "bg-muted font-medium" : "text-muted-foreground")}
              >
                {l === "top" ? "顶层" : "底层"}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <Button size="sm" onClick={apply} disabled={!changed || !valid || saving || busy} className="bg-brand text-brand-foreground hover:bg-brand/85">
            {(saving || busy) && <Loader2 className="animate-spin" />}
            应用并重新布线
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">板中心为 (0, 0)，X 向右、Y 向上。输入框里按 ↑ ↓ 微调。</p>
      </div>
    </div>
  )
}
