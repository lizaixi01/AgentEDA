import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  ArrowLeft,
  Box,
  CircuitBoard,
  ClipboardCheck,
  Code2,
  Factory,
  History,
  ListTree,
  Loader2,
  Moon,
  NotebookText,
  Play,
  RotateCcw,
  Settings as SettingsIcon,
  Sun,
  Waypoints,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, timeAgo, useEvents, type AgentEvent, type BuildProgress, type ProjectState, type Settings } from "@/lib/api"
import { cn } from "@/lib/utils"
import { BomPanel } from "@/components/BomPanel"
import { Board3D } from "@/components/Board3D"
import { ChatPanel } from "@/components/ChatPanel"
import { ChecksPanel } from "@/components/ChecksPanel"
import { ComponentInspector } from "@/components/ComponentInspector"
import { CodePanel } from "@/components/CodePanel"
import { FabPanel } from "@/components/FabPanel"
import { NotesPanel } from "@/components/NotesPanel"
import { Pipeline } from "@/components/Pipeline"
import { SettingsDialog } from "@/components/SettingsDialog"
import { SimPanel } from "@/components/SimPanel"
import { StatusBadge } from "@/components/status"
import { SvgViewer } from "@/components/SvgViewer"

/** Side-by-side resizable split on wide screens; one pane at a time on narrow ones. */
function Shell({ narrow, children }: { narrow: boolean; children: React.ReactNode }) {
  return narrow ? (
    <div className="flex min-h-0 flex-1">{children}</div>
  ) : (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      {children}
    </ResizablePanelGroup>
  )
}

function Pane({
  narrow,
  hidden,
  children,
  ...panel
}: { narrow: boolean; hidden: boolean; children: React.ReactNode } & React.ComponentProps<typeof ResizablePanel>) {
  return narrow ? <div className={cn("min-w-0 flex-1", hidden && "hidden")}>{children}</div> : <ResizablePanel {...panel}>{children}</ResizablePanel>
}

type TabKey = "pcb" | "schematic" | "3d" | "sim" | "bom" | "checks" | "notes" | "code" | "fab"

export function Workspace({
  id,
  initialPrompt,
  dark,
  onToggleTheme,
  onBack,
}: {
  id: string
  initialPrompt: string | null
  dark: boolean
  onToggleTheme: () => void
  onBack: () => void
}) {
  const [state, setState] = useState<ProjectState | null>(null)
  const [missing, setMissing] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTab] = useState<TabKey>("pcb")
  const [progress, setProgress] = useState<BuildProgress | null>(null)
  const [manualBuild, setManualBuild] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [filesTick, setFilesTick] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  // Below ~900px the two panes cannot sit side by side; show one at a time.
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900)
  const [pane, setPane] = useState<"chat" | "preview">(initialPrompt ? "chat" : "preview")
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const bus = useRef(new EventTarget()).current
  const progressTimer = useRef<number | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setState(await api.project(id))
    } catch (e: any) {
      if (e.code === "project_not_found") setMissing(true)
    }
  }, [id])

  useEffect(() => {
    setState(null)
    setMissing(false)
    void refresh()
    api.settings().then(setSettings).catch(() => {})
  }, [id, refresh])

  useEvents(`/api/projects/${id}/events`, {
    progress: (p: BuildProgress) => {
      // A finished build is announced by the "build" event; drop stale ticks after a short grace.
      setProgress(p.stage === "done" ? null : p)
      window.clearTimeout(progressTimer.current)
      if (p.stage !== "done") progressTimer.current = window.setTimeout(() => setProgress(null), 15000)
    },
    build: () => {
      setProgress(null)
      void refresh()
    },
    files: () => {
      setFilesTick((t) => t + 1)
      void refresh()
    },
    activity: () => void refresh(),
    export: () => void refresh(),
    agent: (e: AgentEvent) => bus.dispatchEvent(new CustomEvent("agent", { detail: e })),
  })

  const building = manualBuild || progress !== null

  const build = useCallback(async () => {
    setManualBuild(true)
    try {
      const r = await api.build(id, "manual build")
      if (r.status === "compile_failed") {
        toast.error("编译失败", { description: r.errors?.[0]?.message })
        setTab("checks")
      } else if (!r.ok) {
        toast.warning(`构建完成，但有 ${r.summary.errors} 个错误`)
      } else toast.success(`构建通过 · ${(r.durationMs / 1000).toFixed(1)}s`)
    } catch (e: any) {
      toast.error(e.message, { description: e.hint })
    } finally {
      setManualBuild(false)
      setProgress(null)
      void refresh()
    }
  }, [id, refresh])

  // Cmd/Ctrl+B builds from anywhere in the workspace (the code editor has its own save-and-build).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && !building && !agentRunning) {
        e.preventDefault()
        void build()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [build, building, agentRunning])

  // A project that has sources but was never built (fresh template, blank project) builds itself once.
  const autoBuilt = useRef(false)
  useEffect(() => {
    if (state && !state.report && !initialPrompt && !autoBuilt.current && !state.agentRunning) {
      autoBuilt.current = true
      void build()
    }
  }, [state, initialPrompt, build])

  const restore = async (version: number) => {
    if (!confirm(`把源文件恢复到版本 v${version}？当前未构建的修改会被覆盖。`)) return
    try {
      await api.restore(id, version)
      toast.success(`已恢复到 v${version}，正在重新构建`)
      void build()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const report = state?.report ?? null
  const selectedComponent = report?.components.find((c) => c.name === selected) ?? null
  const version = report?.version
  const compiled = Boolean(report && report.status !== "compile_failed")
  const counts = useMemo(() => ({ errors: report?.errors.length ?? 0, warnings: report?.warnings.length ?? 0 }), [report])

  if (missing)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground">找不到项目 “{id}”。</p>
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft />
          返回项目列表
        </Button>
      </div>
    )
  if (!state)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        加载项目…
      </div>
    )

  const empty = (what: string) => (
    <div className="text-center text-sm text-neutral-400">
      <CircuitBoard className="mx-auto mb-3 size-10 opacity-40" />
      {report?.status === "compile_failed" ? "编译失败，修复后这里会显示" + what : "还没有" + what + "，让 Agent 开始设计或点击右上角“构建”"}
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      {/* top bar */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2.5">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="返回项目列表">
          <ArrowLeft />
        </Button>
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand text-brand-foreground">
          <CircuitBoard className="size-3.5" />
        </div>
        <h1 className="min-w-0 truncate text-sm font-medium">
          <button
            className="max-w-full truncate rounded px-1 hover:bg-muted"
            title="点击重命名"
            onClick={async () => {
              const name = prompt("项目名称", state.meta.name)?.trim()
              if (!name || name === state.meta.name) return
              try {
                await api.renameProject(id, name)
                void refresh()
              } catch (e: any) {
                toast.error(e.message)
              }
            }}
          >
            {state.meta.name}
          </button>
        </h1>
        <StatusBadge status={report?.status} className="shrink-0" />
        {report?.summary.board && (
          <span className="hidden shrink-0 font-mono text-xs text-muted-foreground md:inline">
            {report.summary.board.widthMm}×{report.summary.board.heightMm} mm · {report.summary.board.layers}L
          </span>
        )}
        <span className="flex-1" />

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" disabled={state.versions.length === 0} />}>
            <History />
            <span className="hidden sm:inline">{version ? `v${version}` : "版本"}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
            <DropdownMenuGroup>
              <DropdownMenuLabel>版本历史（每次构建自动保存）</DropdownMenuLabel>
              {[...state.versions].reverse().map((v) => (
                <DropdownMenuItem key={v.version} onClick={() => restore(v.version)} className="gap-2">
                  <span className="w-8 shrink-0 font-mono text-xs">v{v.version}</span>
                  <span className="min-w-0 flex-1 truncate">{v.message}</span>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      v.status === "pass" ? "bg-success" : v.status === "warnings" ? "bg-warning" : "bg-destructive",
                    )}
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(v.createdAt)}</span>
                  {v.version !== version && <RotateCcw className="size-3 shrink-0 text-muted-foreground" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="outline" size="sm" onClick={build} disabled={building || agentRunning}>
          {building ? <Loader2 className="animate-spin" /> : <Play />}
          构建
          <kbd className="hidden font-mono text-[10px] text-muted-foreground lg:inline">⌘B</kbd>
        </Button>
        <Button
          size="sm"
          onClick={() => setTab("fab")}
          disabled={!compiled}
          className="bg-brand text-brand-foreground hover:bg-brand/85"
        >
          <Factory />
          <span className="hidden sm:inline">制造文件</span>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onToggleTheme} aria-label="切换明暗主题">
          {dark ? <Sun /> : <Moon />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setSettingsOpen(true)} aria-label="设置">
          <SettingsIcon />
        </Button>
      </header>

      {/* build progress line */}
      <div className="h-0.5 shrink-0 bg-transparent">
        {building && (
          <div
            className={cn("h-full bg-brand transition-all duration-300", !progress && "bar-indeterminate bg-transparent")}
            style={progress ? { width: `${Math.round(progress.progress * 100)}%` } : undefined}
            role="progressbar"
            aria-label="构建进度"
            aria-valuenow={progress ? Math.round(progress.progress * 100) : undefined}
          />
        )}
      </div>

      {narrow && (
        <div className="flex shrink-0 border-b p-1.5">
          <div className="flex w-full rounded-lg bg-muted p-0.5 text-sm">
            {(["chat", "preview"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setPane(m)}
                aria-pressed={pane === m}
                className={cn("flex-1 rounded-md py-1.5 transition-colors", pane === m ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}
              >
                {m === "chat" ? "对话" : "预览"}
                {m === "chat" && agentRunning && <Loader2 className="ml-1.5 inline size-3 animate-spin text-brand" />}
              </button>
            ))}
          </div>
        </div>
      )}
      <Shell narrow={narrow}>
        <Pane narrow={narrow} hidden={pane !== "chat"} defaultSize="32%" minSize={300} maxSize="55%">
          <ChatPanel
            project={id}
            bus={bus}
            settings={settings}
            activity={state.activity}
            initialPrompt={initialPrompt}
            onOpenSettings={() => setSettingsOpen(true)}
            onRunningChange={setAgentRunning}
          />
        </Pane>
        {!narrow && <ResizableHandle />}
        <Pane narrow={narrow} hidden={pane !== "preview"} minSize={420}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 space-y-2 border-b px-3 py-2">
              <Pipeline state={state} progress={progress} building={building} />
              <div className="flex items-center gap-3 overflow-x-auto">
                <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
                  <TabsList>
                    <TabsTrigger value="pcb">
                      <CircuitBoard />
                      PCB
                    </TabsTrigger>
                    <TabsTrigger value="schematic">
                      <Waypoints />
                      原理图
                    </TabsTrigger>
                    <TabsTrigger value="3d">
                      <Box />
                      3D
                    </TabsTrigger>
                    <TabsTrigger value="sim">
                      <Activity />
                      仿真
                      {report?.simulation && <span className="size-1.5 rounded-full bg-brand" />}
                    </TabsTrigger>
                    <TabsTrigger value="bom">
                      <ListTree />
                      物料
                    </TabsTrigger>
                    <TabsTrigger value="checks">
                      <ClipboardCheck />
                      检查
                      {counts.errors > 0 ? (
                        <span className="rounded-full bg-destructive/15 px-1.5 font-mono text-[10px] text-destructive">{counts.errors}</span>
                      ) : counts.warnings > 0 ? (
                        <span className="rounded-full bg-warning/15 px-1.5 font-mono text-[10px] text-warning">{counts.warnings}</span>
                      ) : null}
                    </TabsTrigger>
                    <TabsTrigger value="notes">
                      <NotebookText />
                      说明
                      {state.files.some((f) => f.path === "NOTES.md") && <span className="size-1.5 rounded-full bg-brand" />}
                    </TabsTrigger>
                    <TabsTrigger value="code">
                      <Code2 />
                      代码
                    </TabsTrigger>
                    <TabsTrigger value="fab">
                      <Factory />
                      制造
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <span className="flex-1" />
                {building ? (
                  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
                    <span className="shimmer-text truncate">
                      {progress?.stage === "analyze" ? "运行规则检查" : progress?.stage === "render" ? "渲染图纸" : "编译 · 布局 · 布线"}
                    </span>
                    {progress && <span className="font-mono tabular-nums">{Math.round(progress.progress * 100)}%</span>}
                  </span>
                ) : report ? (
                  <span className="hidden truncate font-mono text-xs text-muted-foreground lg:inline">
                    {report.summary.traces} 走线 · {report.summary.vias} 过孔
                    {report.summary.areaUsedPct !== undefined ? ` · 占板 ${report.summary.areaUsedPct}%` : ""} · {(report.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </div>
            </div>

            <div className="relative min-h-0 flex-1">
              {tab === "pcb" && (
                <SvgViewer pcb onPickComponent={(name) => name && setSelected(name)} url={compiled && version !== undefined ? api.artifactUrl(id, "pcb.svg", version + "-" + state.meta.updatedAt) : null} empty={empty(" PCB")} />
              )}
              {tab === "pcb" && selectedComponent && report && (
                <ComponentInspector
                  project={id}
                  component={selectedComponent}
                  components={report.components.filter((c) => c.x !== undefined)}
                  busy={building}
                  onSelect={setSelected}
                  onClose={() => setSelected(null)}
                  onApplied={() => void build()}
                />
              )}
              {tab === "schematic" && (
                <SvgViewer
                  light
                  url={compiled && version !== undefined ? api.artifactUrl(id, "schematic.svg", version + "-" + state.meta.updatedAt) : null}
                  empty={empty("原理图")}
                />
              )}
              {tab === "3d" && <Board3D project={id} version={version} available={compiled} />}
              {tab === "sim" && <SimPanel report={report} dark={dark} />}
              {tab === "bom" && <BomPanel project={id} report={report} />}
              {tab === "checks" && (
                <ChecksPanel
                  report={report}
                  onFix={
                    settings?.configured && !agentRunning
                      ? (d) => {
                          bus.dispatchEvent(
                            new CustomEvent("send", {
                              detail: `请修复检查报告里的这个问题，然后重新构建确认：\n[${d.code}] ${d.message}`,
                            }),
                          )
                          setPane("chat")
                          toast.success("已交给 Agent 处理")
                        }
                      : undefined
                  }
                />
              )}
              {tab === "notes" && <NotesPanel state={state} filesTick={filesTick} />}
              {/* Always mounted: the editor holds the only copy of unsaved text, so it is hidden, not removed. */}
              <div className={cn("h-full", tab !== "code" && "hidden")}>
                <CodePanel state={state} filesTick={filesTick} building={building} onBuild={build} dark={dark} />
              </div>
              {tab === "fab" && <FabPanel state={state} onExported={refresh} />}
            </div>
          </div>
        </Pane>
      </Shell>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={settings} onSaved={setSettings} />
    </div>
  )
}
