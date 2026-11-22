import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { Box, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"

/**
 * Orbitable 3D view of the assembled board. The GLB is produced on demand by the server
 * (it is the slowest artifact), so the first open of each build shows a generate step.
 */
export function Board3D({ project, version, available }: { project: string; version: number | undefined; available: boolean }) {
  const mount = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<"idle" | "generating" | "loading" | "ready" | "error">("idle")
  const [error, setError] = useState("")
  const [stamp, setStamp] = useState<string | null>(null)

  // A new build invalidates the model.
  useEffect(() => {
    setStamp(null)
    setState("idle")
  }, [version, project])

  const generate = async () => {
    setState("generating")
    setError("")
    try {
      await api.export3d(project)
      setStamp(`${version}-${Date.now()}`)
    } catch (e: any) {
      setError(e.message)
      setState("error")
    }
  }

  // Generate automatically the first time the tab is shown for a build.
  useEffect(() => {
    if (available && state === "idle" && !stamp) void generate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, state, stamp])

  useEffect(() => {
    const el = mount.current
    if (!el || !stamp) return
    setState("loading")
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, el.clientWidth / Math.max(1, el.clientHeight), 0.1, 5000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(60, 120, 80)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.8)
    fill.position.set(-80, 40, -60)
    scene.add(fill)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    let disposed = false
    new GLTFLoader().load(
      api.artifactUrl(project, "board.glb", stamp),
      (gltf) => {
        if (disposed) return
        const model = gltf.scene
        scene.add(model)
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        model.position.sub(center)
        const radius = Math.max(size.x, size.y, size.z) || 10
        camera.position.set(radius * 0.9, radius * 1.1, radius * 1.2)
        camera.near = radius / 200
        camera.far = radius * 50
        camera.updateProjectionMatrix()
        controls.target.set(0, 0, 0)
        controls.update()
        setState("ready")
      },
      undefined,
      (err) => {
        if (disposed) return
        setError(String((err as any)?.message ?? err))
        setState("error")
      },
    )

    let raf = 0
    const tick = () => {
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()
    const ro = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) return
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(el.clientWidth, el.clientHeight)
    })
    ro.observe(el)
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      scene.traverse((o: any) => {
        o.geometry?.dispose?.()
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
        for (const m of mats) {
          m.map?.dispose?.()
          m.dispose?.()
        }
      })
      renderer.domElement.remove()
    }
  }, [stamp, project])

  return (
    <div className="grid-bg relative h-full w-full bg-background">
      <div ref={mount} className="h-full w-full" />
      {state !== "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          {!available ? (
            <>
              <Box className="size-8 opacity-40" />
              <span>构建成功后可查看 3D 模型</span>
            </>
          ) : state === "error" ? (
            <>
              <span className="max-w-md text-center text-destructive">3D 模型生成失败：{error}</span>
              <Button variant="outline" size="sm" onClick={generate}>
                重试
              </Button>
            </>
          ) : (
            <>
              <Loader2 className="size-6 animate-spin text-brand" />
              <span>{state === "generating" ? "正在生成 3D 模型…" : "正在加载模型…"}</span>
            </>
          )}
        </div>
      )}
      {state === "ready" && (
        <div className="absolute bottom-3 left-3 rounded-md border bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur">
          拖动旋转 · 滚轮缩放 · 右键平移
        </div>
      )}
    </div>
  )
}
