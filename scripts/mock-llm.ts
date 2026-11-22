#!/usr/bin/env bun
/**
 * Development stand-in for the Anthropic Messages API, for exercising the chat loop and
 * UI streaming without credentials. It is NOT a model: it replays one scripted design
 * session (write a deliberately broken board -> build -> fix -> build -> export).
 *
 *   bun scripts/mock-llm.ts            # listens on :4599
 *   then in Settings: API 地址 = http://127.0.0.1:4599, any API key
 */
const PORT = Number(process.env.MOCK_PORT ?? 4599)

const BOARD = (ledPin: string) => `// Scripted demo board: USB-C powered status light.
export default () => (
  <board width="26mm" height="16mm">
    <connector name="J1" standard="usb_c" pcbX={-7.5} pcbY={0} pcbRotation={-90} />
    <resistor name="R1" resistance="5.1k" footprint="0402" pcbX={0} pcbY={5} />
    <resistor name="R2" resistance="5.1k" footprint="0402" pcbX={0} pcbY={-5} />
    <resistor name="R3" resistance="680" footprint="0603" pcbX={4} pcbY={0} />
    <led name="D1" color="red" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C2286"] }} pcbX={8.5} pcbY={0} />
    <copperpour connectsTo="net.GND" layer="top" />

    <trace from="J1.VBUS1" to="net.VBUS" />
    <trace from="J1.VBUS2" to="net.VBUS" />
    <trace from="J1.GND1" to="net.GND" />
    <trace from="J1.GND2" to="net.GND" />
    <trace from="J1.CC1" to="R1.pin1" />
    <trace from="R1.pin2" to="net.GND" />
    <trace from="J1.CC2" to="R2.pin1" />
    <trace from="R2.pin2" to="net.GND" />
    <trace from="R3.pin1" to="net.VBUS" />
    <trace from="R3.pin2" to="D1.${ledPin}" />
    <trace from="D1.cathode" to="net.GND" />
  </board>
)
`

type Block =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }

/** One scripted assistant turn per number of tool results already in the conversation. */
const SCRIPT: { blocks: Block[]; stop: "tool_use" | "end_turn" }[] = [
  {
    stop: "tool_use",
    blocks: [
      { type: "thinking", text: "USB-C 供电的指示灯：需要 CC1/CC2 各接 5.1k 下拉让充电器供电，LED 串限流电阻。5V 下红光 LED 压降约 2V，取 5mA 左右，电阻约 600Ω，用 680Ω。" },
      { type: "text", text: "我先写出第一版设计：USB-C 取电，两颗 5.1k 做 CC 下拉，一颗红色 LED 加限流电阻，顶层铺地。" },
      { type: "tool_use", name: "write_file", input: { content: BOARD("A") } },
    ],
  },
  { stop: "tool_use", blocks: [{ type: "text", text: "设计已写入，开始构建并检查。" }, { type: "tool_use", name: "build", input: { message: "first draft" } }] },
  {
    stop: "tool_use",
    blocks: [
      { type: "text", text: "检查报告指出 D1 没有名为 A 的引脚，LED 的引脚应该叫 anode / cathode。我来改正。" },
      { type: "tool_use", name: "edit_file", input: { old_string: 'to="D1.A"', new_string: 'to="D1.anode"' } },
    ],
  },
  { stop: "tool_use", blocks: [{ type: "tool_use", name: "build", input: { message: "fix LED pin name" } }] },
  { stop: "tool_use", blocks: [{ type: "text", text: "构建通过，我看一眼 PCB 的布局。" }, { type: "tool_use", name: "look", input: { view: "pcb" } }] },
  { stop: "tool_use", blocks: [{ type: "text", text: "布局合理：USB-C 在板边，LED 在另一端。导出制造文件。" }, { type: "tool_use", name: "export_fab", input: {} }] },
  {
    stop: "end_turn",
    blocks: [
      {
        type: "text",
        text: [
          "板子完成了。",
          "",
          "**USB-C 指示灯板**（26 × 16 mm，双层）",
          "",
          "- 电源：USB-C 5V，CC1 / CC2 各 5.1 kΩ 下拉",
          "- 指示：红色 0603 LED，680 Ω 限流，电流约 4.4 mA",
          "- 顶层铺地",
          "",
          "| 项目 | 结果 |",
          "|---|---|",
          "| 规则检查 | 通过 |",
          "| 物料 | 全部匹配立创料号 |",
          "| 制造文件 | 已导出，可在“制造”页下载 |",
          "",
          "**假设**：只取电，不走 USB 数据。**自动检查不覆盖**：LED 亮度是否合适，建议按实际需求调整 R3。",
          "",
          "_（这是脚本化的演示回复，不是真实模型的输出。）_",
        ].join("\n"),
      },
    ],
  },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    if (!url.pathname.endsWith("/v1/messages") || req.method !== "POST") return new Response("mock-llm: only POST /v1/messages", { status: 404 })
    const body: any = await req.json()
    const toolResults = (body.messages ?? []).reduce(
      (n: number, m: any) => n + (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result").length : 0),
      0,
    )
    // Count only results since the last plain user message so a second chat turn restarts the script.
    let sinceUser = 0
    for (const m of body.messages ?? []) {
      if (m.role === "user" && (typeof m.content === "string" || !m.content.some((b: any) => b.type === "tool_result"))) sinceUser = 0
      else if (m.role === "user") sinceUser += m.content.filter((b: any) => b.type === "tool_result").length
    }
    void toolResults
    const step = SCRIPT[Math.min(sinceUser, SCRIPT.length - 1)]!
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        send("message_start", {
          type: "message_start",
          message: {
            id: `msg_mock_${Date.now()}`,
            type: "message",
            role: "assistant",
            model: body.model ?? "mock",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        })
        let index = 0
        for (const block of step.blocks) {
          if (block.type === "tool_use") {
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_mock_${Date.now()}_${index}`, name: block.name, input: {} } })
            const jsonText = JSON.stringify(block.input)
            for (let i = 0; i < jsonText.length; i += 90) {
              send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: jsonText.slice(i, i + 90) } })
              await sleep(25)
            }
          } else if (block.type === "thinking") {
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })
            for (let i = 0; i < block.text.length; i += 6) {
              send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.text.slice(i, i + 6) } })
              await sleep(20)
            }
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "mock" } })
          } else {
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
            for (let i = 0; i < block.text.length; i += 4) {
              send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(i, i + 4) } })
              await sleep(15)
            }
          }
          send("content_block_stop", { type: "content_block_stop", index })
          index++
        }
        send("message_delta", { type: "message_delta", delta: { stop_reason: step.stop, stop_sequence: null }, usage: { output_tokens: 300 } })
        send("message_stop", { type: "message_stop" })
        controller.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})
console.log(`mock-llm (scripted, not a model) on http://127.0.0.1:${PORT}`)
