/** Rasterise build previews to PNG so vision-capable agents can inspect their work. */
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { Resvg } from "@resvg/resvg-js"
import { buildDir, requireProject, EdaError } from "./project"

export type View = "pcb" | "schematic" | "assembly" | "simulation"
const VIEWS: readonly View[] = ["pcb", "schematic", "assembly", "simulation"]

export async function renderPng(id: string, view: View = "pcb", width = 1000): Promise<Uint8Array> {
  requireProject(id)
  // `view` becomes part of a file path and both arguments arrive from HTTP: accept only known values.
  if (!VIEWS.includes(view)) throw new EdaError("bad_view", `Unknown view "${String(view)}"`, `Use one of: ${VIEWS.join(", ")}.`)
  width = Math.min(2400, Math.max(300, Math.trunc(Number(width)) || 1000))
  const file = path.join(buildDir(id), `${view}.svg`)
  if (!existsSync(file))
    throw new EdaError("not_built", `No ${view} preview for "${id}"`, view === "simulation" ? "Add <voltageprobe> and <analogsimulation> to the design, then build." : "Call build first; previews are produced by a successful compile.")
  const svg = await fs.readFile(file, "utf8")
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    background: view === "schematic" || view === "simulation" ? "#ffffff" : "#000000",
    font: { loadSystemFonts: true },
  })
  return resvg.render().asPng()
}
