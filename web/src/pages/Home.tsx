import { useCallback, useEffect, useState } from "react"
import { ArrowUp, CircuitBoard, Loader2, Moon, Plug, Plus, Settings as SettingsIcon, Sun, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { api, timeAgo, useEvents, type ProjectMeta, type Settings, type TemplateInfo } from "@/lib/api"
import { SettingsDialog } from "@/components/SettingsDialog"
import { StatusBadge } from "@/components/status"

const IDEAS = [
  { title: "USB-C 小夜灯", prompt: "做一个 USB-C 供电的小夜灯：4 颗暖白 LED，带一个轻触开关，板子尽量小，适合嘉立创贴片。" },
  { title: "ESP32-C3 开发板", prompt: "做一块 ESP32-C3-MINI 最小系统板：USB-C 供电和下载，3.3V LDO，复位和 BOOT 按键，一颗状态 LED，两排 2.54mm 排针引出全部 GPIO。" },
  { title: "温湿度传感器节点", prompt: "做一个 I2C 温湿度传感器小板：SHT30 传感器，3.3V 供电，4 针排针引出 VCC/GND/SDA/SCL，带上拉电阻和去耦电容。" },
  { title: "555 呼吸闪烁灯", prompt: "用 NE555 做一个约 1Hz 闪烁的 LED 板，5V 排针供电，全部用 0603 贴片器件。" },
  { title: "锂电池充电板", prompt: "做一个单节锂电池充电板：USB-C 输入，TP4056 充电 IC，充电中和充满两颗指示灯，电池用 JST PH 2.0 接口。" },
  { title: "双路电机驱动", prompt: "做一个双路直流电机驱动板：DRV8833，输入 2.7-10V，四个控制信号用排针引出，两个电机用接线端子。" },
]

function nameFromPrompt(prompt: string) {
  const first = prompt.split(/[。.!！?？\n：:]/)[0].replace(/^(请|帮我|给我)?(做|设计|画)(一个|一块|个|块)?/, "").trim()
  return (first || prompt).slice(0, 24) || "新项目"
}

export function Home({
  dark,
  onToggleTheme,
  onOpen,
}: {
  dark: boolean
  onToggleTheme: () => void
  onOpen: (id: string, prompt?: string) => void
}) {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null)
  const [prompt, setPrompt] = useState("")
  const [creating, setCreating] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const load = useCallback(() => api.projects().then(setProjects).catch(() => setProjects([])), [])
  useEffect(() => {
    void load()
    api.settings().then(setSettings).catch(() => {})
    api.templates().then(setTemplates).catch(() => {})
  }, [load])

  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [usingTemplate, setUsingTemplate] = useState<string | null>(null)
  const useTemplate = async (t: TemplateInfo) => {
    if (usingTemplate) return
    setUsingTemplate(t.id)
    try {
      const state = await api.createFromTemplate(t.id)
      onOpen(state.meta.id)
    } catch (e: any) {
      toast.error(e.message)
      setUsingTemplate(null)
    }
  }
  useEvents("/api/events", { projects: () => void load() })

  const create = async (text: string) => {
    const requirement = text.trim()
    if (!requirement || creating) return
    setCreating(true)
    try {
      const state = await api.createProject(nameFromPrompt(requirement), requirement)
      onOpen(state.meta.id, requirement)
    } catch (e: any) {
      toast.error(e.message)
      setCreating(false)
    }
  }

  const blank = async () => {
    setCreating(true)
    try {
      const state = await api.createProject("未命名项目")
      onOpen(state.meta.id)
    } catch (e: any) {
      toast.error(e.message)
      setCreating(false)
    }
  }

  const remove = async (p: ProjectMeta) => {
    if (!confirm(`删除项目“${p.name}”？设计文件和历史版本都会被删除，无法恢复。`)) return
    try {
      await api.deleteProject(p.id)
      void load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
        <div className="flex size-6 items-center justify-center rounded-md bg-brand text-brand-foreground">
          <CircuitBoard className="size-3.5" />
        </div>
        <span className="text-sm font-semibold tracking-tight">AgentEDA</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">给 Agent 用的 PCB 设计工具</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          <Plug />
          <span className="hidden sm:inline">连接 Agent</span>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onToggleTheme} aria-label="切换明暗主题">
          {dark ? <Sun /> : <Moon />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setSettingsOpen(true)} aria-label="设置">
          <SettingsIcon />
        </Button>
      </header>

      <section className="grid-bg relative border-b">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-background/60 to-background" />
        <div className="relative mx-auto max-w-3xl px-4 pt-16 pb-12 sm:pt-24">
          <h1 className="text-center text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            一句话，做出能下单的<span className="text-brand">电路板</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-center text-sm leading-relaxed text-pretty text-muted-foreground sm:text-base">
            描述你想要的硬件。Agent 负责选型、原理图、布局布线和规则检查，输出可直接上传嘉立创的 Gerber、BOM 和贴片坐标。
          </p>

          <form
            className="mt-8 rounded-2xl border bg-card shadow-lg transition-colors focus-within:border-brand/60"
            onSubmit={(e) => {
              e.preventDefault()
              void create(prompt)
            }}
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void create(prompt)
                }
              }}
              rows={3}
              autoFocus
              placeholder="例如：做一个 USB-C 供电的 3.3V 稳压小板，带电源指示灯，输出用 2.54mm 排针"
              className="block w-full resize-none bg-transparent px-4 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
              aria-label="描述你想做的硬件"
            />
            <div className="flex items-center gap-2 px-3 pb-3">
              <Button type="button" variant="ghost" size="sm" onClick={blank} disabled={creating}>
                <Plus />
                空白项目
              </Button>
              <span className="flex-1" />
              <span className="hidden text-xs text-muted-foreground sm:inline">⌘↵ 开始</span>
              <Button type="submit" disabled={!prompt.trim() || creating} className="bg-brand text-brand-foreground hover:bg-brand/85">
                {creating ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                开始设计
              </Button>
            </div>
          </form>

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {IDEAS.map((idea) => (
              <button
                key={idea.title}
                onClick={() => setPrompt(idea.prompt)}
                className="rounded-full border bg-background/70 px-3 py-1 text-xs text-muted-foreground backdrop-blur transition-colors hover:border-brand/50 hover:text-foreground"
              >
                {idea.title}
              </button>
            ))}
          </div>

          {settings && !settings.configured && (
            <p className="mt-5 text-center text-xs text-muted-foreground">
              内置 Agent 还没有模型密钥。
              <button className="text-brand underline underline-offset-2" onClick={() => setSettingsOpen(true)}>
                填写密钥
              </button>
              ，或者把 AgentEDA 作为 MCP 工具接入你自己的 Agent。
            </p>
          )}
        </div>
      </section>

      {templates.length > 0 && (
        <section className="mx-auto max-w-6xl px-4 pt-8">
          <div className="mb-4 flex items-baseline gap-3">
            <h2 className="text-sm font-medium">从模板开始</h2>
            <span className="text-xs text-muted-foreground">已通过全部检查的完整设计，打开即可修改和导出</span>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => useTemplate(t)}
                  disabled={usingTemplate !== null}
                  className="group flex w-full items-stretch gap-3 overflow-hidden rounded-xl border bg-card p-2 text-left transition-colors hover:border-brand/50 disabled:opacity-60"
                >
                  <div className="flex h-24 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black">
                    <img
                      src={`/api/templates/${t.id}/preview.svg`}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-contain p-1 transition-transform duration-300 group-hover:scale-105"
                    />
                  </div>
                  <div className="min-w-0 flex-1 py-1 pr-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{t.name}</span>
                      {usingTemplate === t.id && <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {t.tags.map((tag) => (
                        <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-sm font-medium">我的项目</h2>
          {projects && <span className="text-xs text-muted-foreground">{projects.length} 个</span>}
        </div>
        {projects === null ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            加载中…
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">还没有项目。在上面写下第一个想法。</div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id} className="group relative overflow-hidden rounded-xl border bg-card transition-colors hover:border-brand/50">
                <button className="block w-full text-left" onClick={() => onOpen(p.id)}>
                  <div className="flex aspect-[16/9] items-center justify-center overflow-hidden bg-black">
                    {p.status && p.status !== "compile_failed" ? (
                      <img
                        src={api.artifactUrl(p.id, "pcb.svg", p.updatedAt)}
                        alt={`${p.name} 的 PCB 预览`}
                        loading="lazy"
                        className="h-full w-full object-contain p-2 transition-transform duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <CircuitBoard className="size-10 text-neutral-700" />
                    )}
                  </div>
                  <div className="space-y-1.5 p-3">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                      <StatusBadge status={p.status} className="shrink-0" />
                    </div>
                    <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">{p.description || "—"}</p>
                    <div className="text-[11px] text-muted-foreground">更新于 {timeAgo(p.updatedAt)}</div>
                  </div>
                </button>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => remove(p)}
                  aria-label={`删除项目 ${p.name}`}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={settings} onSaved={setSettings} />
    </div>
  )
}
