import { useEffect, useState } from "react"
import { Check, Copy, KeyRound, Loader2, Plug, Terminal } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type Settings } from "@/lib/api"
import { cn } from "@/lib/utils"

const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "默认，均衡" },
  { id: "claude-fable-5-2", label: "Fable 5.2", note: "最强，较贵" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "更快更省" },
]
const EFFORTS = [
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "很高" },
]

function CopyRow({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted px-2.5 py-2 font-mono text-xs whitespace-nowrap">{text}</code>
        <Button
          variant="outline"
          size="icon"
          aria-label="复制"
          onClick={async () => {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings | null
  onSaved: (s: Settings) => void
}) {
  const [apiKey, setApiKey] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [model, setModel] = useState("claude-opus-5-5")
  const [effort, setEffort] = useState("high")
  const [provider, setProvider] = useState<string>("auto")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open && settings) {
      setApiKey("")
      setBaseURL(settings.baseURL ?? "")
      setModel(settings.model)
      setEffort(settings.effort)
      setProvider(settings.providerSetting)
    }
  }, [open, settings])

  const save = async () => {
    setSaving(true)
    try {
      const next = await api.saveSettings({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), baseURL: baseURL.trim(), model: model.trim(), effort, provider })
      onSaved(next)
      toast.success("设置已保存")
      onOpenChange(false)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const mcp = settings?.mcpCommand ?? "bun run src/mcp.ts"
  const root = settings?.root ?? "."

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>选择由谁来驱动设计：内置 Agent，或你自己的 Agent。</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={settings?.configured ? "model" : "model"}>
          <TabsList className="w-full">
            <TabsTrigger value="model">
              <KeyRound />
              内置 Agent
            </TabsTrigger>
            <TabsTrigger value="mcp">
              <Plug />
              外部 Agent（MCP）
            </TabsTrigger>
            <TabsTrigger value="cli">
              <Terminal />
              命令行
            </TabsTrigger>
          </TabsList>

          <TabsContent value="model" className="space-y-4 pt-3">
            <div className="space-y-1.5">
              <Label>由谁来运行对话</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["auto", "自动选择", "按可用情况挑一个"],
                    ["claude-code", "Claude Code", settings?.providers.claudeCode.available ? "用 Claude 订阅，需先 /login" : "未找到 claude 命令"],
                    ["codex", "Codex", settings?.providers.codex.available ? (settings.providers.codex.loggedIn ? "用 ChatGPT 登录 · 已登录" : "已安装，未登录") : "未找到 codex 命令"],
                    ["anthropic", "Anthropic API", settings?.providers.anthropic.available ? "已有密钥" : "需要填写密钥"],
                  ] as const
                ).map(([id, label, note]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setProvider(id)}
                    aria-pressed={provider === id}
                    className={cn("rounded-lg border px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted", provider === id && "border-brand bg-brand/10")}
                  >
                    <div className="font-medium">{label}</div>
                    <div className="text-xs text-muted-foreground">{note}</div>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                当前生效：
                {settings?.provider === "codex"
                  ? "Codex（本机登录）"
                  : settings?.provider === "claude-code"
                    ? "Claude Code（Claude 订阅）"
                    : settings?.provider === "anthropic"
                      ? "Anthropic API"
                      : "无"}
                。用 Claude Code 或 Codex 时不需要 API Key；它们只能使用当前项目的 AgentEDA 工具。
              </p>
            </div>
            <div
              className={cn(
                "rounded-lg border px-3 py-2 text-sm",
                settings?.configured ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10",
              )}
            >
              {settings?.configured
                ? settings.provider === "anthropic"
                  ? `已找到 API 凭据（来源：${settings.source === "settings" ? "本页保存的密钥" : settings.source}）`
                  : "对话可以直接使用，不需要 API Key"
                : "还没有可用的模型"}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="apiKey">Anthropic API Key</Label>
              <Input
                id="apiKey"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings?.source === "settings" ? "已保存，留空则不修改" : "sk-ant-…"}
              />
              <p className="text-xs text-muted-foreground">只保存在本机项目目录的 .aeda-config.json（已加入 .gitignore），不会上传到别处。</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="baseURL">API 地址（可选）</Label>
              <Input id="baseURL" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="留空使用官方地址；走网关或代理时填写" />
            </div>
            <div className="space-y-1.5">
              <Label>模型</Label>
              <div className="grid grid-cols-3 gap-2">
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModel(m.id)}
                    className={cn(
                      "rounded-lg border px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted",
                      model === m.id && "border-brand bg-brand/10",
                    )}
                    aria-pressed={model === m.id}
                  >
                    <div className="font-medium">{m.label}</div>
                    <div className="text-xs text-muted-foreground">{m.note}</div>
                  </button>
                ))}
              </div>
              <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono text-xs" aria-label="模型 ID" />
            </div>
            <div className="space-y-1.5">
              <Label>思考强度</Label>
              <div className="flex gap-2">
                {EFFORTS.map((e) => (
                  <Button key={e.id} type="button" size="sm" variant={effort === e.id ? "default" : "outline"} onClick={() => setEffort(e.id)}>
                    {e.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="animate-spin" />}
                保存
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="mcp" className="space-y-4 pt-3 text-sm">
            <p className="leading-relaxed text-muted-foreground">
              AgentEDA 的全部能力都以 MCP 工具暴露。把它接到 Claude Code、Claude Desktop、Cursor 等任意 Agent，它们画板子时，这个页面会实时刷新。
            </p>
            <CopyRow label="Claude Code" text={`claude mcp add agenteda -- ${mcp}`} />
            <CopyRow
              label="其他 MCP 客户端（JSON 配置）"
              text={JSON.stringify({ mcpServers: { agenteda: { command: mcp.split(" ")[0], args: mcp.split(" ").slice(1) } } })}
            />
            <CopyRow label="安装配套 Skill（Claude Code）" text={`mkdir -p ~/.claude/skills && cp -r ${root}/skills/agenteda ~/.claude/skills/`} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              工具列表：get_guide、create_project、write_file、edit_file、build、get_report、render、search_parts、import_part、export_fab 等。
            </p>
          </TabsContent>

          <TabsContent value="cli" className="space-y-4 pt-3 text-sm">
            <p className="leading-relaxed text-muted-foreground">每个工具同时是一条命令，输出一律是 JSON，出错时退出码为 1，适合脚本和任何能跑 shell 的 Agent。</p>
            <CopyRow label="查看所有命令" text={`cd ${root} && bun src/cli.ts help`} />
            <CopyRow label="设计指南（给 Agent 读）" text={`cd ${root} && bun src/cli.ts guide`} />
            <CopyRow label="构建并检查" text={`cd ${root} && bun src/cli.ts build <project> --detail`} />
            <CopyRow label="导出制造文件" text={`cd ${root} && bun src/cli.ts export_fab <project>`} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
