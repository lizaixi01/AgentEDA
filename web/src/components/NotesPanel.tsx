import { useEffect, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { NotebookText } from "lucide-react"
import { api, timeAgo, type ProjectState } from "@/lib/api"

/**
 * The design note the agent leaves in NOTES.md: calculated values, assumptions,
 * what was not verified. Shown with the original requirement above it.
 */
export function NotesPanel({ state, filesTick }: { state: ProjectState; filesTick: number }) {
  const id = state.meta.id
  const has = state.files.some((f) => f.path === "NOTES.md")
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    if (!has) {
      setText(null)
      return
    }
    let alive = true
    api
      .readFile(id, "NOTES.md")
      .then((r) => alive && setText(r.content))
      .catch(() => alive && setText(null))
    return () => {
      alive = false
    }
  }, [id, has, filesTick])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-5">
        <section className="rounded-xl border bg-card p-4">
          <div className="text-xs text-muted-foreground">需求 · 创建于 {timeAgo(state.meta.createdAt)}</div>
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap">{state.meta.description || "（创建项目时没有填写需求）"}</p>
        </section>
        {text ? (
          <section className="rounded-xl border bg-card p-5">
            <div className="md text-sm">
              <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
            </div>
          </section>
        ) : (
          <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
            <NotebookText className="mx-auto mb-3 size-8 opacity-40" />
            <p className="font-medium text-foreground">还没有设计说明</p>
            <p className="mx-auto mt-2 max-w-md leading-relaxed">
              Agent 完成设计后会在项目里写一份 <code className="rounded bg-muted px-1 font-mono text-xs">NOTES.md</code>
              ：计算过的数值、做的假设、没有对照数据手册核实的地方、已知的取舍。下单前请先看这一页。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
