/**
 * Self-contained HTML design report: one file a reviewer can open offline.
 * Everything is inlined (SVG previews, tables, notes); no scripts, no network.
 */
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { buildDir, projectDir, readMeta, EdaError } from "./project"
import { readReport } from "./build"

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

/** Minimal Markdown to HTML for NOTES.md: headings, bold, code, lists, paragraphs. Input is escaped first. */
function markdown(src: string): string {
  const inline = (t: string) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
  const out: string[] = []
  let list = false
  const closeList = () => {
    if (list) out.push("</ul>")
    list = false
  }
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd()
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const li = line.match(/^\s*[-*]\s+(.*)$/)
    if (h) {
      closeList()
      out.push(`<h${h[1]!.length + 1}>${inline(h[2]!)}</h${h[1]!.length + 1}>`)
    } else if (li) {
      if (!list) out.push("<ul>")
      list = true
      out.push(`<li>${inline(li[1]!)}</li>`)
    } else if (line.trim() === "") {
      closeList()
    } else {
      closeList()
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  closeList()
  return out.join("\n")
}

/**
 * Embed an SVG preview as a data-URI image. As an <img> it cannot run scripts and its
 * internal stylesheet cannot leak into the page or into the other previews.
 */
async function svgOf(id: string, file: string, alt: string): Promise<string> {
  const f = path.join(buildDir(id), file)
  if (!existsSync(f)) return ""
  let svg = await fs.readFile(f, "utf8")
  svg = svg.replace(/<svg\b([^>]*)>/, (_all, attrs: string) => {
    const w = attrs.match(/\bwidth="([\d.]+)"/)?.[1]
    const h = attrs.match(/\bheight="([\d.]+)"/)?.[1]
    return w && h && !/viewBox=/.test(attrs) ? `<svg${attrs} viewBox="0 0 ${w} ${h}">` : `<svg${attrs}>`
  })
  return `<img alt="${esc(alt)}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`
}

export async function exportReport(id: string): Promise<{ file: string; bytes: number }> {
  const meta = await readMeta(id)
  const r = await readReport(id)
  if (!r || r.status === "compile_failed")
    throw new EdaError("not_built", `Project "${id}" has no successful build to report on`, "Call build first.")
  const notesFile = path.join(projectDir(id), "NOTES.md")
  const notes = existsSync(notesFile) ? await fs.readFile(notesFile, "utf8") : ""
  const [pcb, sch, sim] = await Promise.all([
    svgOf(id, "pcb.svg", "PCB layout"),
    svgOf(id, "schematic.svg", "Schematic"),
    svgOf(id, "simulation.svg", "Simulation waveforms"),
  ])
  const s = r.summary
  const b = s.board
  const statusText = r.errors.length ? `${r.errors.length} error(s)` : r.warnings.length ? `passes, ${r.warnings.length} warning(s)` : "all checks pass"
  const statusTone = r.errors.length ? "bad" : r.warnings.length ? "warn" : "good"
  const diag = (title: string, items: typeof r.errors, tone: string) =>
    items.length
      ? `<h3>${title} (${items.length})</h3><ul class="diag ${tone}">${items
          .map((d) => `<li><code>${esc(d.code)}</code> ${esc(d.message)}${d.hint ? `<div class="hint">${esc(d.hint)}</div>` : ""}</li>`)
          .join("")}</ul>`
      : ""
  const dfmRows = (r.dfm?.rules ?? [])
    .filter((x) => x.status !== "n/a")
    .map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${x.measured} mm</td><td class="num">&ge; ${x.limit} mm</td><td class="${x.status}">${x.status}</td></tr>`)
    .join("")
  const simRows = (r.simulation?.probes ?? [])
    .map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.minV}</td><td class="num">${p.maxV}</td><td class="num">${p.meanV}</td><td class="num">${p.settled?.peakToPeakV ?? "&mdash;"}</td><td class="num">${p.frequencyHz ?? "&mdash;"}</td></tr>`)
    .join("")

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.name)} · design report</title>
<style>
  :root { --bg:#fbfbfa; --fg:#1b1b1a; --muted:#66655f; --line:#e1e0d9; --card:#fff; --good:#0a7a3f; --warn:#9a6700; --bad:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#f0efec; --muted:#a3a299; --line:#2c2c2a; --card:#1e1e1d; --good:#4ac88a; --warn:#e0b040; --bad:#f08070; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 36px 0 12px; } h3 { font-size: 14px; margin: 18px 0 8px; } h4 { font-size: 13px; margin: 14px 0 6px; }
  .sub { color: var(--muted); }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; border:1px solid currentColor; }
  .good { color: var(--good); } .warn, .marginal { color: var(--warn); } .bad, .fail { color: var(--bad); } .pass { color: var(--good); }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-top:16px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .stat b { display:block; font-size:20px; font-variant-numeric: tabular-nums; } .stat span { color:var(--muted); font-size:12px; }
  .fig { background:#000; border:1px solid var(--line); border-radius:10px; padding:12px; overflow:hidden; } .fig.light { background:#f5f1ed; }
  .fig img { display:block; width:100%; height:auto; max-height:640px; object-fit:contain; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; font-size:13px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; } tr:last-child td { border-bottom:0; }
  th { color:var(--muted); font-weight:500; font-size:12px; } .num { text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap; }
  code { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; background:color-mix(in srgb, var(--fg) 8%, transparent); padding:1px 5px; border-radius:4px; }
  ul.diag { list-style:none; padding:0; margin:0; } ul.diag li { background:var(--card); border:1px solid var(--line); border-left:3px solid currentColor; border-radius:8px; padding:8px 12px; margin-bottom:8px; color:var(--fg); }
  ul.diag.bad li { border-left-color: var(--bad); } ul.diag.warn li { border-left-color: var(--warn); }
  .hint { color:var(--muted); font-size:12px; margin-top:4px; }
  .notes { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:4px 18px 12px; } .notes h2 { margin-top:16px; }
  .scroll { overflow-x:auto; } footer { margin-top:40px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<main>
  <h1>${esc(meta.name)}</h1>
  <div class="sub">${esc(meta.description)}</div>
  <p><span class="badge ${statusTone}">${statusText}</span> <span class="sub">build v${r.version ?? "?"} · ${new Date().toISOString().slice(0, 10)}</span></p>
  <div class="grid">
    <div class="stat"><b>${b ? `${b.widthMm} × ${b.heightMm}` : "&mdash;"}</b><span>board, mm · ${b?.layers ?? "?"} layers</span></div>
    <div class="stat"><b>${s.components}</b><span>components</span></div>
    <div class="stat"><b>${s.connectionsRouted}/${s.connectionsTotal}</b><span>connections routed</span></div>
    <div class="stat"><b>${s.bomSourced}/${s.bomLines}</b><span>BOM lines with LCSC part</span></div>
    <div class="stat"><b>${s.bomCostUsd != null ? `$${s.bomCostUsd.toFixed(2)}` : "&mdash;"}</b><span>parts cost per board</span></div>
  </div>

  ${notes ? `<h2>Design notes</h2><div class="notes">${markdown(notes)}</div>` : ""}

  <h2>PCB</h2>
  <div class="fig">${pcb || "<p class='sub'>no PCB preview</p>"}</div>
  <h2>Schematic</h2>
  <div class="fig light">${sch || "<p class='sub'>no schematic preview</p>"}</div>
  ${sim ? `<h2>Simulation</h2><div class="fig light">${sim}</div><div class="scroll"><table style="margin-top:12px"><tr><th>Probe</th><th class="num">min V</th><th class="num">max V</th><th class="num">mean V</th><th class="num">settled p-p V</th><th class="num">Hz</th></tr>${simRows}</table></div>` : ""}

  <h2>Checks</h2>
  ${r.errors.length + r.warnings.length === 0 ? `<p class="good">No errors or warnings. Automated checks cover connectivity, geometry, sourcing and a few electrical rules; they do not prove the circuit works.</p>` : ""}
  ${diag("Errors", r.errors, "bad")}
  ${diag("Warnings", r.warnings, "warn")}
  ${dfmRows ? `<h3>Manufacturability (${esc(r.dfm?.fab)})</h3><div class="scroll"><table><tr><th>Rule</th><th class="num">On this board</th><th class="num">Fab limit</th><th>Result</th></tr>${dfmRows}</table></div>` : ""}

  <h2>Bill of materials</h2>
  <div class="scroll"><table>
    <tr><th class="num">Qty</th><th>Designators</th><th>Value / part</th><th>Footprint</th><th>LCSC</th><th class="num">Unit USD</th></tr>
    ${r.bom
      .map(
        (l) =>
          `<tr><td class="num">${l.qty}</td><td>${esc(l.designators.join(", "))}</td><td>${esc(l.value || l.mpn || l.kind)}${l.mpn && l.mpn !== l.value ? `<div class="sub">${esc(l.mpn)}</div>` : ""}</td><td><code>${esc(l.footprint || "-")}</code></td><td>${l.lcsc ? esc(l.lcsc) + (l.basic === undefined ? "" : l.basic ? " · basic" : " · extended") : '<span class="warn">not sourced</span>'}</td><td class="num">${l.unitPrice != null ? l.unitPrice.toFixed(4) : "&mdash;"}</td></tr>`,
      )
      .join("")}
  </table></div>

  <h2>Nets</h2>
  <div class="scroll"><table>
    <tr><th>Net</th><th class="num">Pins</th><th class="num">Typical width</th><th>Connected pins</th></tr>
    ${r.nets
      .filter((n) => n.pins.length > 1)
      .map((n) => `<tr><td><code>${esc(n.name)}</code></td><td class="num">${n.pins.length}</td><td class="num">${n.traceWidthMm !== undefined ? `${n.traceWidthMm} mm` : "&mdash;"}</td><td class="sub">${esc(n.pins.join("  "))}</td></tr>`)
      .join("")}
  </table></div>

  <footer>Generated by AgentEDA from project <code>${esc(id)}</code>. Review the design notes and every warning before ordering.</footer>
</main>
</body>
</html>
`
  const out = path.join(buildDir(id), "report.html")
  await fs.writeFile(out, html)
  return { file: out, bytes: Buffer.byteLength(html) }
}
