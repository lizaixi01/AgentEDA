import { useCallback, useEffect, useRef, useState } from "react"
import { Download, Maximize, Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/** Make a fixed-size SVG scale to its container: add a viewBox, drop pixel dimensions. */
function normalize(svg: string): string {
  return svg.replace(/<svg\b([^>]*)>/, (_all, attrs: string) => {
    const w = attrs.match(/\bwidth="([\d.]+)"/)?.[1]
    const h = attrs.match(/\bheight="([\d.]+)"/)?.[1]
    let next = attrs.replace(/\s(width|height)="[^"]*"/g, "")
    if (w && h && !/viewBox=/.test(next)) next += ` viewBox="0 0 ${w} ${h}"`
    return `<svg${next} preserveAspectRatio="xMidYMid meet">`
  })
}

/**
 * Pan / zoom stage for a server-rendered SVG (schematic, PCB, assembly).
 * Wheel zooms around the cursor, drag pans, double-click or the button fits.
 */
const LAYERS = [
  { id: "top", label: "顶层铜", color: "rgb(200, 52, 52)", css: '[data-pcb-layer="top"]:is([data-type="pcb_trace"],[data-type="pcb_smtpad"])' },
  { id: "bottom", label: "底层铜", color: "rgb(77, 127, 196)", css: '[data-pcb-layer="bottom"]:is([data-type="pcb_trace"],[data-type="pcb_smtpad"])' },
  { id: "pour", label: "铺铜", color: "rgb(60, 90, 140)", css: ".pcb-copper-pour" },
  { id: "silk", label: "丝印", color: "#f2eda1", css: '[data-type^="pcb_silkscreen"]' },
  { id: "holes", label: "孔 / 过孔", color: "#ff26e2", css: ':is([data-type="pcb_via"],[data-type="pcb_plated_hole"],[data-type="pcb_plated_hole_drill"],[data-type="pcb_hole"])' },
] as const

export function SvgViewer({
  url,
  light,
  empty,
  pcb,
  onPickComponent,
}: {
  url: string | null
  light?: boolean
  empty?: React.ReactNode
  /** Enables PCB extras: layer toggles, pad tooltips, click-to-highlight a net */
  pcb?: boolean
  /** Called with a designator when a pad of that part is clicked */
  onPickComponent?: (name: string | null) => void
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<{ x: number; y: number; pad: string; net: string } | null>(null)
  const [net, setNet] = useState<string | null>(null)
  const moved = useRef(false)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  useEffect(() => {
    if (!url) {
      setSvg(null)
      return
    }
    let alive = true
    setFailed(false)
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => alive && setSvg(normalize(text)))
      .catch(() => alive && (setSvg(null), setFailed(true)))
    return () => {
      alive = false
    }
  }, [url])

  const fit = useCallback(() => setView({ x: 0, y: 0, k: 1 }), [])

  // Non-passive wheel listener so the page itself never scrolls while zooming.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      setView((v) => {
        const k = Math.min(40, Math.max(0.3, v.k * Math.exp(-e.deltaY * 0.0015)))
        const f = k / v.k
        return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f }
      })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const zoomBy = (f: number) => setView((v) => ({ ...v, k: Math.min(40, Math.max(0.3, v.k * f)), x: v.x * f, y: v.y * f }))

  return (
    <div className={cn("relative h-full w-full overflow-hidden", light ? "bg-[#f5f1ed]" : "bg-black")}>
      <div
        ref={stage}
        className={cn("h-full w-full touch-none select-none", drag.current ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
          moved.current = false
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) {
            if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) moved.current = true
            setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
            return
          }
          if (!pcb) return
          const pad = (e.target as Element).closest?.("[data-pad-name]")
          if (pad) {
            const rect = e.currentTarget.getBoundingClientRect()
            setHover({
              x: e.clientX - rect.left,
              y: e.clientY - rect.top,
              pad: pad.getAttribute("data-pad-name") ?? "",
              net: pad.getAttribute("data-pad-net-name") ?? "",
            })
          } else if (hover) setHover(null)
        }}
        onPointerUp={(e) => {
          drag.current = null
          if (!pcb || moved.current) return
          // A click (not a drag) on a pad pins its net; a click elsewhere clears it.
          const pad = (e.target as Element).closest?.("[data-pad-net-name]")
          const clicked = pad?.getAttribute("data-pad-net-name") || null
          setNet((cur) => (clicked && clicked !== cur ? clicked : null))
          const padName = (e.target as Element).closest?.("[data-pad-name]")?.getAttribute("data-pad-name")
          onPickComponent?.(padName ? padName.split(".")[0] : null)
        }}
        onPointerLeave={() => {
          drag.current = null
          setHover(null)
        }}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={fit}
      >
        {svg ? (
          <div
            className="svg-stage h-full w-full p-4"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "center" }}
            // SVG comes from our own build pipeline on the local server.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-8">
            {url && !failed ? <Skeleton className="h-2/3 w-2/3 opacity-20" /> : (empty ?? null)}
          </div>
        )}
      </div>
      {pcb && svg && (
        <style>{`
          ${LAYERS.filter((l) => hidden.has(l.id))
            .map((l) => `.svg-stage ${l.css} { display: none; }`)
            .join("\n")}
          ${net ? `.svg-stage [data-pad-name]:not([data-pad-net-name="${CSS.escape(net)}"]) { opacity: 0.25; }
          .svg-stage [data-pad-net-name="${CSS.escape(net)}"] { stroke: #fff; stroke-width: 1.2; }
          .svg-stage [data-type="pcb_trace"], .svg-stage .pcb-copper-pour { opacity: 0.35; }` : ""}
          .svg-stage [data-pad-name] { cursor: pointer; }
        `}</style>
      )}
      {pcb && svg && (
        <div className="absolute top-3 left-3 flex flex-wrap items-center gap-1 rounded-lg border bg-background/85 p-1 shadow-sm backdrop-blur">
          {LAYERS.map((l) => {
            const off = hidden.has(l.id)
            return (
              <button
                key={l.id}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev)
                    if (off) next.delete(l.id)
                    else next.add(l.id)
                    return next
                  })
                }
                aria-pressed={!off}
                className={cn("flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted", off && "text-muted-foreground line-through opacity-60")}
              >
                <span className="size-2 rounded-full" style={{ background: off ? "transparent" : l.color, boxShadow: `inset 0 0 0 1px ${l.color}` }} />
                {l.label}
              </button>
            )
          })}
        </div>
      )}
      {pcb && net && (
        <div className="absolute top-14 left-3 flex items-center gap-2 rounded-lg border bg-background/90 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur">
          <span className="text-muted-foreground">高亮网络</span>
          <span className="font-mono font-medium">{net}</span>
          <button className="text-muted-foreground hover:text-foreground" onClick={() => setNet(null)} aria-label="取消高亮">
            ✕
          </button>
        </div>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1 font-mono text-xs shadow-md"
          style={{ left: Math.min(hover.x + 12, (stage.current?.clientWidth ?? 9999) - 160), top: hover.y + 12 }}
        >
          <span className="font-medium">{hover.pad}</span>
          {hover.net && <span className="ml-2 text-muted-foreground">{hover.net}</span>}
        </div>
      )}
      {svg && (
        <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-lg border bg-background/85 p-1 shadow-sm backdrop-blur">
          <Button variant="ghost" size="icon-sm" onClick={() => zoomBy(1 / 1.3)} aria-label="缩小">
            <Minus />
          </Button>
          <span className="w-11 text-center font-mono text-xs text-muted-foreground tabular-nums">{Math.round(view.k * 100)}%</span>
          <Button variant="ghost" size="icon-sm" onClick={() => zoomBy(1.3)} aria-label="放大">
            <Plus />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={fit} aria-label="适应窗口">
            <Maximize />
          </Button>
          {url && (
            <Button variant="ghost" size="icon-sm" aria-label="下载 SVG" title="下载 SVG" render={<a href={url} download={url.split("/").pop()?.split("?")[0]} />}>
              <Download />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
