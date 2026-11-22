import { useState } from "react"
import { ExternalLink, Loader2, PackageSearch, Search } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type PartHit, type Report } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Meter } from "./status"

const partUrl = (lcsc: string) => `https://jlcpcb.com/partdetail/${lcsc}`

export function BomPanel({ project, report }: { project: string; report: Report | null }) {
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<PartHit[] | null>(null)
  const [note, setNote] = useState("")
  const [searching, setSearching] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)

  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    setNote("")
    try {
      const r = await api.searchParts(query.trim())
      setHits(r.parts)
      setNote(r.note ?? "")
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSearching(false)
    }
  }

  const importPart = async (lcsc: string) => {
    setImporting(lcsc)
    try {
      const r = await api.importPart(project, lcsc)
      toast.success(`已导入 ${r.mpn}`, { description: `${r.file} · 用法 ${r.usage}` })
    } catch (e: any) {
      toast.error(e.message, { description: e.hint })
    } finally {
      setImporting(null)
    }
  }

  const bom = report?.bom ?? []
  const s = report?.summary

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 p-5">
        {s && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border bg-card p-4 sm:grid-cols-4">
            <Meter label="已匹配立创料号" value={s.bomSourced} total={s.bomLines} tone={s.bomSourced === s.bomLines ? "bg-success" : "bg-warning"} />
            <Fact label="器件总数" value={s.components} />
            <Fact label="物料种类" value={s.bomLines} note={s.extendedParts ? `其中 ${s.extendedParts} 种为扩展库` : undefined} />
            <Fact label="单板物料成本" value={s.bomCostUsd != null ? `$${s.bomCostUsd.toFixed(2)}` : "—"} />
          </div>
        )}

        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-2.5 text-sm font-medium">物料清单</div>
          {bom.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">构建后这里会列出物料清单。</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 text-right">数量</TableHead>
                  <TableHead>位号</TableHead>
                  <TableHead>参数 / 型号</TableHead>
                  <TableHead>封装</TableHead>
                  <TableHead>立创料号</TableHead>
                  <TableHead className="text-right">单价 (USD)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bom.map((line) => (
                  <TableRow key={line.designators.join(",")}>
                    <TableCell className="text-right font-mono tabular-nums">{line.qty}</TableCell>
                    <TableCell className="max-w-48 font-mono text-xs whitespace-normal">{line.designators.join(", ")}</TableCell>
                    <TableCell>
                      <div className="font-medium">{line.value || line.mpn || line.kind}</div>
                      <div className="max-w-64 truncate text-xs text-muted-foreground" title={line.partDescription}>
                        {line.mpn && line.mpn !== line.value ? line.mpn : line.kind}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground" title={line.footprint}>
                      {line.footprint || "—"}
                    </TableCell>
                    <TableCell>
                      {line.lcsc ? (
                        <a
                          href={partUrl(line.lcsc)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-xs text-brand hover:underline"
                        >
                          {line.lcsc}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        <Badge variant="outline" className="border-warning/30 bg-warning/10 font-normal text-warning">
                          未匹配
                        </Badge>
                      )}
                      {line.lcsc && line.basic !== undefined && (
                        <span className={cn("ml-2 text-[11px]", line.basic ? "text-success" : "text-muted-foreground")}>{line.basic ? "基础库" : "扩展库"}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{line.unitPrice != null ? line.unitPrice.toFixed(4) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        {report && report.nets.filter((n) => n.pins.length > 1).length > 0 && (
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b px-4 py-2.5 text-sm font-medium">网络表</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>网络</TableHead>
                  <TableHead className="text-right">引脚数</TableHead>
                  <TableHead className="text-right">典型线宽</TableHead>
                  <TableHead>连接的引脚</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.nets
                  .filter((n) => n.pins.length > 1)
                  .map((n) => (
                    <TableRow key={n.name}>
                      <TableCell className="font-mono text-xs font-medium">
                        {n.name}
                        {n.isGround && <span className="ml-1.5 font-sans text-[10px] text-muted-foreground">地</span>}
                        {n.isPower && !n.isGround && <span className="ml-1.5 font-sans text-[10px] text-copper">电源</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{n.pins.length}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{n.traceWidthMm !== undefined ? `${n.traceWidthMm} mm` : "—"}</TableCell>
                      <TableCell className="max-w-md font-mono text-xs whitespace-normal text-muted-foreground">{n.pins.join("  ")}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </section>
        )}

        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
            <PackageSearch className="size-4 text-muted-foreground" />
            立创商城器件搜索
          </div>
          <form
            className="flex gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault()
              void search()
            }}
          >
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="型号或关键词，例如 AMS1117-3.3、ESP32-C3、USB-C 16pin" />
            <Button type="submit" variant="outline" disabled={searching || !query.trim()}>
              {searching ? <Loader2 className="animate-spin" /> : <Search />}
              搜索
            </Button>
          </form>
          {note && <div className="px-4 pb-3 text-xs text-muted-foreground">{note}</div>}
          {hits && hits.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>型号</TableHead>
                  <TableHead>封装</TableHead>
                  <TableHead className="text-right">库存</TableHead>
                  <TableHead className="text-right">单价 (USD)</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {hits.map((h) => (
                  <TableRow key={h.lcsc}>
                    <TableCell className="max-w-72 whitespace-normal">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{h.mpn}</span>
                        <a href={partUrl(h.lcsc)} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:underline">
                          {h.lcsc}
                        </a>
                        {h.basic && (
                          <Badge variant="outline" className="h-5 border-success/30 bg-success/10 px-1.5 font-normal text-success">
                            基础库
                          </Badge>
                        )}
                      </div>
                      {h.description && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{h.description}</div>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{h.package}</TableCell>
                    <TableCell className={cn("text-right font-mono text-xs tabular-nums", h.stock !== null && h.stock < 100 && "text-warning")}>
                      {h.stock !== null ? h.stock.toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{h.price != null ? h.price.toFixed(4) : "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" disabled={importing !== null} onClick={() => importPart(h.lcsc)}>
                        {importing === h.lcsc && <Loader2 className="animate-spin" />}
                        导入到项目
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </div>
  )
}

function Fact({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-2xl leading-tight font-semibold tabular-nums">{value}</div>
      {note && <div className="text-[11px] text-muted-foreground">{note}</div>}
    </div>
  )
}
