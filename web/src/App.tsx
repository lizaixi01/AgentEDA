import { useCallback, useEffect, useState } from "react"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Home } from "@/pages/Home"
import { Workspace } from "@/pages/Workspace"

/** Hash routes: "#/" home, "#/p/<id>" workspace. */
function parse(hash: string): { page: "home" } | { page: "project"; id: string } {
  const m = hash.match(/^#\/p\/([^/?]+)/)
  return m ? { page: "project", id: decodeURIComponent(m[1]) } : { page: "home" }
}

function readTheme(): boolean {
  try {
    const saved = localStorage.getItem("aeda-theme")
    if (saved) return saved === "dark"
  } catch {}
  return true
}

export default function App() {
  const [route, setRoute] = useState(() => parse(location.hash))
  const [dark, setDark] = useState(readTheme)
  // A prompt typed on the home page is handed to the workspace once, in memory only.
  const [pending, setPending] = useState<{ id: string; prompt: string } | null>(null)

  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash))
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    try {
      localStorage.setItem("aeda-theme", dark ? "dark" : "light")
    } catch {}
  }, [dark])

  const toggle = useCallback(() => setDark((d) => !d), [])
  const open = useCallback((id: string, prompt?: string) => {
    setPending(prompt ? { id, prompt } : null)
    location.hash = `#/p/${encodeURIComponent(id)}`
  }, [])

  return (
    <TooltipProvider>
      <div className="h-full">
        {route.page === "home" ? (
          <Home dark={dark} onToggleTheme={toggle} onOpen={open} />
        ) : (
          <Workspace
            key={route.id}
            id={route.id}
            initialPrompt={pending?.id === route.id ? pending.prompt : null}
            dark={dark}
            onToggleTheme={toggle}
            onBack={() => (location.hash = "#/")}
          />
        )}
      </div>
      <Toaster theme={dark ? "dark" : "light"} position="bottom-right" richColors />
    </TooltipProvider>
  )
}
