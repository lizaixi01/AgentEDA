import { useCallback, useEffect, useRef, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  Eye,
  FileCode2,
  FileSearch,
  Hammer,
  History,
  KeyRound,
  Loader2,
  PackageCheck,
  PackagePlus,
  Pencil,
  Plug,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { api, timeAgo, type ActivityEntry, type AgentEvent, type Settings, type TranscriptItem, type TranscriptPart } from "@/lib/api"
import { cn } from "@/lib/utils"

const TOOL_META: Record<string, { label: string; running: string; icon: typeof Hammer }> = {
  build: { label: "构建并检查", running: "正在布局、布线并运行检查", icon: Hammer },
  write_file: { label: "写入设计", running: "正在编写电路代码", icon: FileCode2 },
  edit_file: { label: "修改设计", running: "正在修改电路代码", icon: Pencil },
  read_file: { label: "读取文件", running: "正在读取文件", icon: FileSearch },
  list_files: { label: "查看文件列表", running: "正在查看文件", icon: FileSearch },
  get_report: { label: "读取检查报告", running: "正在读取检查报告", icon: FileSearch },
  search_parts: { label: "搜索器件", running: "正在搜索立创商城", icon: Search },
  import_part: { label: "导入器件", running: "正在导入器件封装", icon: PackagePlus },
  export_fab: { label: "导出制造文件", running: "正在生成 Gerber / BOM / 坐标文件", icon: PackageCheck },
  look: { label: "查看图纸", running: "正在查看图纸", icon: Eye },
  render: { label: "查看图纸", running: "正在查看图纸", icon: Eye },
  export_report: { label: "生成设计报告", running: "正在生成设计报告", icon: PackageCheck },
  place_component: { label: "调整器件位置", running: "正在调整器件位置", icon: Pencil },
  browse_parts: { label: "筛选器件", running: "正在按参数筛选器件", icon: Search },
  get_guide: { label: "阅读设计指南", running: "正在阅读设计指南", icon: FileSearch },
  list_versions: { label: "查看版本历史", running: "正在查看版本", icon: History },
  restore_version: { label: "恢复版本", running: "正在恢复版本", icon: History },
  create_project: { label: "创建项目", running: "正在创建项目", icon: Cpu },
  export_3d: { label: "导出 3D 模型", running: "正在生成 3D 模型", icon: PackageCheck },
}

type ToolPart = Extract<TranscriptPart, { type: "tool" }>

function ToolCard({ part, live, project }: { part: ToolPart; live: boolean; project: string }) {
  const [open, setOpen] = useState(false)
  const meta = TOOL_META[part.name] ?? { label: part.name, running: part.name, icon: Cpu }
  const Icon = meta.icon
  const running = part.ok === undefined && live
  const interrupted = part.ok === undefined && !live
  const detail =
    part.name === "search_parts"
      ? part.input?.query
      : part.name === "import_part"
        ? part.input?.lcsc
        : part.name === "look" || part.name === "render"
          ? (part.input?.view ?? "pcb")
          : (part.input?.path ?? part.input?.message ?? "")
  const pct = part.progress ? Math.round(part.progress.progress * 100) : null

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card text-sm", part.ok === false && "border-destructive/40")}>
      <button className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/40" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            running ? "bg-brand/15 text-brand" : part.ok === false ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground",
          )}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn("font-medium", running && "shimmer-text")}>{running ? meta.running : meta.label}</span>
            {detail ? <span className="truncate font-mono text-xs text-muted-foreground">{String(detail)}</span> : null}
          </span>
          {!running && part.summary && <span className="block truncate text-xs text-muted-foreground">{part.summary}</span>}
          {interrupted && <span className="block text-xs text-muted-foreground">已中断</span>}
        </span>
        {part.ok === true && <Check className="size-3.5 shrink-0 text-success" />}
        {part.ok === false && <X className="size-3.5 shrink-0 text-destructive" />}
        {part.durationMs !== undefined && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{(part.durationMs / 1000).toFixed(1)}s</span>
        )}
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {running && (
        <div className="px-3 pb-2.5">
          {pct !== null ? (
            <>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                <span className="truncate">{stageLabel(part.progress!.stage)}</span>
                <span className="font-mono tabular-nums">{pct}%</span>
              </div>
            </>
          ) : (
            <>
              <div className="bar-indeterminate h-1 rounded-full bg-muted" />
              {part.inputBytes ? (
                <div className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums">已生成 {part.inputBytes.toLocaleString()} 字符</div>
              ) : null}
            </>
          )}
        </div>
      )}
      {open && (part.name === "look" || part.name === "render") && part.ok && (
        <div className="border-t bg-black p-2">
          <img
            src={`/api/projects/${project}/render.png?view=${encodeURIComponent(part.input?.view ?? "pcb")}&width=700&t=${part.id}`}
            alt={`Agent 查看的${part.input?.view ?? "pcb"}图`}
            className="mx-auto max-h-72 rounded"
          />
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t bg-muted/30 p-3">
          <Json label="输入" value={part.input} />
          {part.result !== undefined && part.result !== null && <Json label="结果" value={part.result} />}
        </div>
      )}
    </div>
  )
}

function stageLabel(stage: string) {
  return stage === "compile" ? "编译 · 自动布局 · 自动布线" : stage === "analyze" ? "电气规则与设计规则检查" : stage === "render" ? "渲染原理图与 PCB" : "完成"
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{label}</div>
      <pre className="max-h-64 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className="text-xs text-muted-foreground">
      <button className="flex items-center gap-1.5 hover:text-foreground" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Brain className="size-3.5" />
        <span className={cn(live && "shimmer-text")}>{live ? "思考中" : "思考过程"}</span>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="mt-1.5 border-l-2 pl-3 leading-relaxed whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

function Message({ item, live, project }: { item: TranscriptItem; live: boolean; project: string }) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap">
          {item.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
        </div>
      </div>
    )
  }
  const lastIndex = item.parts.length - 1
  return (
    <div className="space-y-2.5">
      {item.parts.map((p, i) => {
        if (p.type === "text")
          return (
            <div key={i} className="md text-sm">
              <Markdown remarkPlugins={[remarkGfm]}>{p.text}</Markdown>
            </div>
          )
        if (p.type === "thinking") return <Thinking key={i} text={p.text} live={live && i === lastIndex} />
        if (p.type === "tool") return <ToolCard key={p.id} part={p} live={live} project={project} />
        return (
          <div key={i} className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {p.text}
          </div>
        )
      })}
      {live && item.parts.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          <span className="shimmer-text">正在理解需求</span>
        </div>
      )}
    </div>
  )
}

/** Apply one streamed agent event to the transcript (pure). */
function reduce(items: TranscriptItem[], e: AgentEvent): TranscriptItem[] {
  if (e.type === "start") {
    if (items.some((i) => i.id === e.messageId)) return items
    return [...items, { id: e.messageId, role: "assistant", parts: [], at: new Date().toISOString() }]
  }
  const idx = items.length - 1
  const last = items[idx]
  if (!last || last.role !== "assistant") return items
  const parts = [...last.parts]
  const tail = parts[parts.length - 1]
  const patchTool = (id: string, patch: Partial<ToolPart>) => {
    const i = parts.findIndex((p) => p.type === "tool" && p.id === id)
    if (i >= 0) parts[i] = { ...(parts[i] as ToolPart), ...patch }
  }
  switch (e.type) {
    case "text":
    case "thinking":
      if (tail && tail.type === e.type) parts[parts.length - 1] = { ...tail, text: tail.text + e.delta }
      else parts.push({ type: e.type, text: e.delta })
      break
    case "tool_start":
      parts.push({ type: "tool", id: e.id, name: e.name, input: {} })
      break
    case "tool_input_delta":
      patchTool(e.id, { inputBytes: e.bytes })
      break
    case "tool_input": {
      const input = e.name === "write_file" ? { ...e.input, content: undefined, bytes: String(e.input?.content ?? "").length } : e.input
      patchTool(e.id, { input })
      break
    }
    case "tool_progress":
      patchTool(e.id, { progress: e.progress })
      break
    case "tool_end":
      patchTool(e.id, { ok: e.ok, summary: e.summary, result: e.result, durationMs: e.durationMs, progress: undefined })
      break
    case "error":
      if (!(tail && tail.type === "error" && tail.text === e.message)) parts.push({ type: "error", text: e.message })
      break
    default:
      return items
  }
  const next = [...items]
  next[idx] = { ...last, parts }
  return next
}

/** Projects whose home-page prompt has already been sent; survives the panel being remounted. */
const sentInitialPrompts = new Set<string>()

const SOURCE_LABEL: Record<string, string> = { mcp: "MCP", cli: "CLI", http: "API", web: "界面", agent: "内置 Agent" }

export function ChatPanel({
  project,
  bus,
  settings,
  activity,
  initialPrompt,
  onOpenSettings,
  onRunningChange,
}: {
  project: string
  bus: EventTarget
  settings: Settings | null
  activity: ActivityEntry[]
  /** Sent automatically once (used when a project is created from the home prompt) */
  initialPrompt?: string | null
  onOpenSettings: () => void
  onRunningChange: (running: boolean) => void
}) {
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [running, setRunning] = useState(false)
  const [draft, setDraft] = useState("")
  const [loaded, setLoaded] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const sentInitial = useRef(false)

  const setRun = useCallback(
    (v: boolean) => {
      setRunning(v)
      onRunningChange(v)
    },
    [onRunningChange],
  )

  useEffect(() => {
    let alive = true
    setLoaded(false)
    api
      .chat(project)
      .then((r) => {
        if (!alive) return
        setItems(r.transcript)
        setRun(r.running)
        setLoaded(true)
      })
      .catch(() => alive && setLoaded(true))
    return () => {
      alive = false
    }
  }, [project, setRun])

  useEffect(() => {
    const onAgent = (ev: Event) => {
      const e = (ev as CustomEvent<AgentEvent>).detail
      if (e.type === "start") setRun(true)
      if (e.type === "done") {
        setRun(false)
        return
      }
      setItems((prev) => reduce(prev, e))
    }
    bus.addEventListener("agent", onAgent)
    return () => bus.removeEventListener("agent", onAgent)
  }, [bus, setRun])

  // Keep pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, activity.length, running])

  const send = useCallback(
    async (text: string) => {
      const message = text.trim()
      if (!message || running) return
      setItems((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", parts: [{ type: "text", text: message }], at: new Date().toISOString() }])
      setDraft("")
      stick.current = true
      setRun(true)
      try {
        await api.sendChat(project, message)
      } catch (e: any) {
        setRun(false)
        toast.error(e.message)
      }
    },
    [project, running, setRun],
  )

  // Other panels (e.g. "ask the agent to fix this") hand a message over the bus.
  useEffect(() => {
    const onSend = (ev: Event) => void send((ev as CustomEvent<string>).detail)
    bus.addEventListener("send", onSend)
    return () => bus.removeEventListener("send", onSend)
  }, [bus, send])

  useEffect(() => {
    if (loaded && initialPrompt && !sentInitial.current && !sentInitialPrompts.has(project) && items.length === 0 && settings?.configured) {
      sentInitial.current = true
      sentInitialPrompts.add(project)
      void send(initialPrompt)
    }
  }, [loaded, initialPrompt, items.length, settings?.configured, send])

  const clear = async () => {
    if (!confirm("清空这个项目的对话记录？设计文件不受影响。")) return
    await api.clearChat(project)
    setItems([])
  }

  const configured = settings?.configured ?? true
  // Work done by outside agents (MCP / CLI) is shown as a timeline so the panel is never blind to it.
  const external = activity.filter((a) => a.source !== "agent" && a.source !== "web").slice(-12)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="space-y-5 p-4">
          {loaded && items.length === 0 && (
            <div className="space-y-3 pt-2">
              <div>
                <h2 className="text-base font-medium">说说你想做什么板子</h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  我会选型、画原理图、布局布线、跑规则检查，直到可以下单。你可以随时打断我，或者直接改右边的代码。
                </p>
              </div>
              {initialPrompt && !configured && (
                <div className="rounded-lg border bg-card p-3 text-sm">
                  <div className="text-xs text-muted-foreground">你的需求</div>
                  <div className="mt-1 whitespace-pre-wrap">{initialPrompt}</div>
                </div>
              )}
              {!configured && (
                <div className="space-y-3 rounded-xl border border-warning/30 bg-warning/5 p-3.5 text-sm">
                  <div className="flex items-start gap-2.5">
                    <KeyRound className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div>
                      <div className="font-medium">内置 Agent 还没有可用的模型</div>
                      <p className="mt-0.5 text-muted-foreground">三选一：登录 Claude Code（Claude 订阅）、登录 Codex，或填入 Anthropic API Key。</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={onOpenSettings}>
                      <KeyRound />
                      填写密钥
                    </Button>
                    <Button size="sm" variant="outline" onClick={onOpenSettings}>
                      <Plug />
                      用 Claude Code 等外部 Agent 连接
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const text = `用 AgentEDA（MCP 服务 agenteda）完成项目 "${project}" 的 PCB 设计${initialPrompt ? `，需求：${initialPrompt}` : ""}。先调用 get_guide 读设计指南，再写设计，反复 build 直到 ok 为 true，最后 export_fab，并说明你做的假设。`
                        await navigator.clipboard.writeText(text)
                        toast.success("已复制，可以粘贴给 Claude Code 等外部 Agent")
                      }}
                    >
                      <Copy />
                      复制给外部 Agent 的指令
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {items.map((item, i) => (
            <Message key={item.id} item={item} project={project} live={running && i === items.length - 1 && item.role === "assistant"} />
          ))}
          {running && items[items.length - 1]?.role === "user" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="shimmer-text">正在理解需求</span>
            </div>
          )}

          {external.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Plug className="size-3.5" />
                外部 Agent 的操作
                <span className="h-px flex-1 bg-border" />
              </div>
              <ul className="space-y-1">
                {external.map((a, i) => {
                  const Icon = (TOOL_META[a.tool] ?? { icon: Cpu }).icon
                  return (
                    <li key={`${a.at}-${i}`} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs">
                      <Icon className={cn("size-3.5 shrink-0", a.ok ? "text-muted-foreground" : "text-destructive")} />
                      <span className="min-w-0 flex-1 truncate">{a.summary}</span>
                      <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{SOURCE_LABEL[a.source] ?? a.source}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(a.at)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="border-t p-3">
        <form
          className="rounded-xl border bg-card shadow-sm transition-colors focus-within:border-brand/60"
          onSubmit={(e) => {
            e.preventDefault()
            void send(draft)
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send(draft)
              }
            }}
            rows={2}
            placeholder={configured ? "描述需求或提出修改，例如：把板子缩到 25×18mm，再加一个复位按键" : "先在设置里连接一个模型（Claude 订阅 / Codex / API Key），或用外部 Agent 通过 MCP 连接"}
            className="block max-h-48 min-h-14 w-full resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-muted-foreground"
            aria-label="给 Agent 的消息"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            {items.length > 0 && !running && (
              <Button type="button" variant="ghost" size="icon-sm" onClick={clear} aria-label="清空对话" title="清空对话">
                <Trash2 />
              </Button>
            )}
            <span className="ml-1 truncate text-[11px] text-muted-foreground">
              {!settings
                ? ""
                : settings.provider === "codex"
                  ? "Codex · 本机登录"
                  : settings.provider === "claude-code"
                    ? "Claude Code · 订阅"
                    : settings.provider === "anthropic"
                      ? settings.model
                      : "未连接模型"}
            </span>
            <span className="flex-1" />
            {running ? (
              <Button type="button" size="icon-sm" variant="secondary" onClick={() => api.stopChat(project)} aria-label="停止" title="停止">
                <Square className="fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-sm"
                disabled={!draft.trim() || !configured}
                className="bg-brand text-brand-foreground hover:bg-brand/85"
                aria-label="发送"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
