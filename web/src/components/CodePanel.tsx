import { useCallback, useEffect, useRef, useState } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { githubDark, githubLight } from "@uiw/codemirror-theme-github"
import { FileCode2, Loader2, Play, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { api, formatBytes, type ProjectState } from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * Source editor. The agent and the user edit the same files: when a file changes on disk
 * and there are no unsaved local edits, the editor reloads it.
 */
export function CodePanel({
  state,
  filesTick,
  building,
  onBuild,
  dark,
}: {
  state: ProjectState
  /** increments whenever the server reports a source file change */
  filesTick: number
  building: boolean
  onBuild: () => void
  dark: boolean
}) {
  const id = state.meta.id
  const files = state.files.filter((f) => f.path !== "aeda.json")
  const [active, setActive] = useState("index.circuit.tsx")
  const [code, setCode] = useState("")
  const [saved, setSaved] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const dirty = code !== saved
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const load = useCallback(
    async (path: string, force = false) => {
      if (!force && dirtyRef.current) return
      try {
        const r = await api.readFile(id, path)
        setCode(r.content)
        setSaved(r.content)
      } catch (e: any) {
        toast.error(e.message)
      } finally {
        setLoading(false)
      }
    },
    [id],
  )

  useEffect(() => {
    setLoading(true)
    void load(active, true)
  }, [active, load])

  useEffect(() => {
    if (filesTick > 0) void load(active)
  }, [filesTick, active, load])

  useEffect(() => {
    if (!files.some((f) => f.path === active) && files.length) setActive(files[0].path)
  }, [files, active])

  const save = async (thenBuild = false) => {
    setSaving(true)
    try {
      if (dirty) {
        await api.writeFile(id, active, code)
        setSaved(code)
      }
      if (thenBuild) onBuild()
      else toast.success("已保存")
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="flex h-full min-h-0"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault()
          void save(e.shiftKey)
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault()
          void save(true)
        }
      }}
    >
      <aside className="w-52 shrink-0 overflow-y-auto border-r bg-card/50 p-2">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">文件</div>
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => {
              if (dirty && !confirm("当前文件有未保存的修改，切换后会丢失。继续吗？")) return
              setActive(f.path)
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
              f.path === active && "bg-muted font-medium",
            )}
            title={`${f.path} · ${formatBytes(f.bytes)}`}
          >
            <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-xs">{f.path}</span>
          </button>
        ))}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="truncate font-mono text-xs">{active}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-warning" title="未保存" />}
          <span className="ml-auto hidden text-xs text-muted-foreground lg:inline">⌘S 保存 · ⌘↵ 保存并构建</span>
          <Button variant="ghost" size="sm" onClick={() => save(false)} disabled={!dirty || saving}>
            <Save />
            保存
          </Button>
          <Button size="sm" onClick={() => save(true)} disabled={saving || building} className="bg-brand text-brand-foreground hover:bg-brand/85">
            {building ? <Loader2 className="animate-spin" /> : <Play />}
            保存并构建
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
            </div>
          ) : (
            <CodeMirror
              value={code}
              onChange={setCode}
              height="100%"
              theme={dark ? githubDark : githubLight}
              extensions={[javascript({ jsx: true, typescript: true })]}
              basicSetup={{ tabSize: 2 }}
              className="h-full text-[13px] [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono"
            />
          )}
        </div>
      </div>
    </div>
  )
}
