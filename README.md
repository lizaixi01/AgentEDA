# AgentEDA

给 Agent 用的 PCB 设计工具。一句话需求 → 原理图 → 布局布线 → 规则检查 → 可上传嘉立创的 Gerber / BOM / 贴片坐标。

板子是一份代码（TSX），`build` 是验证闭环：编译、自动布局、自动布线、匹配立创料号、跑 ERC / DRC，返回带修复提示的结构化报告。Agent 照着报告改，直到通过。

## 启动

需要 [Bun](https://bun.sh) 1.4 以上。

```bash
bun install
```

```bash
bun run build:web
```

```bash
bun run start
```

打开 http://127.0.0.1:4477 。

## 三种用法

### 1. 网页里直接对话（内置 Agent）

左边对话，右边实时预览 PCB、原理图、3D、仿真、物料、检查结果和代码。对话由下面三种引擎之一驱动，在右上角“设置”里选择，默认自动挑一个可用的：

| 引擎 | 需要什么 | 说明 |
|---|---|---|
| Codex | 本机已安装并登录 Codex（ChatGPT 桌面应用自带，或 `codex` 命令） | 用 ChatGPT 登录，不需要 API Key。已用真实对话验证 |
| Claude Code | 本机有 `claude` 命令（或 Claude 桌面应用自带的那份），并已用 Claude 订阅 `/login` | 用 Claude 订阅，不需要 API Key。启动和未登录提示已验证，登录后的完整对话还没有实测 |
| Anthropic API | 在设置里填 API Key，或启动前设置 `ANTHROPIC_API_KEY` | 只用脚本化的替身模型验证过 |

用 Codex 或 Claude Code 时，AgentEDA 启动对应的命令行，并只把“绑定到当前项目的 MCP 工具”交给它：这些工具只作用于当前项目，也不能改写项目元数据、构建配置或依赖。这限定的是工具范围，不是沙箱：构建会执行 Agent 写的设计代码（见“安全说明”）。Claude Code 还被关掉了全部内置工具（没有 shell 和文件访问）；Codex 运行在只读沙箱里，并被要求只使用这些工具。

### 2. 接入你自己的 Agent（MCP）

```bash
claude mcp add agenteda -- bun run /absolute/path/to/AgentEDA/src/mcp.ts
```

配套 Skill 在 `skills/agenteda/`，复制到 `~/.claude/skills/` 即可。外部 Agent 画板子时，网页会实时刷新，并在对话栏显示它的操作记录。

### 3. 命令行

每个工具都是一条命令，输出是 JSON；工具调用本身出错（参数错误、项目不存在等）时退出码为 1。注意 `build` 检查出设计错误或编译失败时仍然退出 0，要看输出里的 `ok` 字段。 `bin/aeda` 是同一个入口的包装脚本，可以软链到 PATH 里当 `aeda` 命令用。

```bash
bun src/cli.ts help
```

```bash
bun src/cli.ts create_project --template esp32-c3-dev-board
```

```bash
bun src/cli.ts build esp32-c3-dev-board --pretty
```

```bash
bun src/cli.ts export_fab esp32-c3-dev-board
```

## 验证闭环里有什么

每次 `build` 都会跑下面这些检查，结果以结构化 JSON 返回，每条问题带修复提示：

| 检查 | 内容 |
|---|---|
| 编译 | 语法、导入、属性、连线选择器是否有效，报错带文件和行号 |
| 连通性 | 网表中每条连接是否都有铜皮（未布通的连接逐个列出） |
| 摆放与间距 | 器件重叠、超出板框、铜皮间距、连接器朝向 |
| 物料 | 每个器件是否有立创料号，单价、基础库 / 扩展库，单板物料成本，LED / 二极管极性是否与料号一致 |
| 电气规则 | LED 是否有限流电阻、USB-C 的 CC 脚是否下拉、芯片电源脚是否去耦、电源 / 地引脚是否悬空、I2C 是否有上拉 |
| 连通性复核 | 独立于布线器，用铜皮几何重建实际的电气连接，再和网表逐个网络比对，铜皮没有真正接上的引脚报 `layout_open` |
| 间距复核 | 独立于布线器，用几何直接计算每一对不同网络的走线、焊盘、过孔之间的最小间距，发现短路或小于 0.1 mm 的间距即报错并给出坐标 |
| 可制造性 | 线宽、过孔、焊环、孔径等实测最小值对比嘉立创双层板工艺极限 |
| 电源走线 | 每个网络的典型线宽，电源网络过细时提醒 |
| 仿真（可选） | 设计里加信号源和探针后运行 SPICE 瞬态仿真，返回每个探针的最小 / 最大 / 平均电压、频率、占空比 |

`export_fab` 之后还有一步 **Gerber 回读校验**：用独立的第三方解析器把导出的 Gerber 重新读回，核对图层是否齐全、板框尺寸是否与设计一致，并渲染出工厂视角的预览图。

## Agent 友好度实测

四个不带任何上下文的 Agent，只拿到 `skills/agenteda/SKILL.md` 和命令行，各自从零完成一块板子（不许看源码和模板）：

| 需求 | 结果 | 构建次数 |
|---|---|---|
| USB-C 小夜灯（4 颗 LED + 拨动开关） | 20 × 17 mm，12 个器件，24/24 布通，导出校验通过 | 第 2 次通过 |
| 电池电压检测板（分压 + RC 滤波 + LDO，带仿真） | 36 × 24 mm，10 个器件，仿真分压 3.000 V 与理论一致 | 第 2 次通过，共 7 次 |
| CH340C USB 转串口板 | 18 × 24 mm，13 个器件，34/34 布通，导出校验通过 | 第 1 次通过，共 3 次 |
| RP2040 最小系统板（压力测试） | 58 × 32 mm，33 个器件，122/122 布通，导出校验通过 | 第 6 次通过，共 7 次 |

它们报告的四十多个摩擦点（文档写错的枚举值、张冠李戴的提示、仿真失败不报错、构建依赖 PATH 等）已逐条修复，并写回了设计指南。这些板子的电气正确性由 Agent 自己负责，没有人工复核。

## 工具一览

| 工具 | 作用 |
|---|---|
| `get_guide` | 设计指南：语法、封装名、已验证的料号、完整示例 |
| `list_templates` / `create_project` | 新建项目（空白、带代码、或基于已验证模板） |
| `write_file` / `edit_file` / `read_file` / `list_files` | 读写设计文件 |
| `place_component` | 调整单个器件的位置、角度、所在层 |
| `build` | 编译 + 布局布线 + 检查，返回报告 |
| `get_report` | 读取上一次构建的报告 |
| `search_parts` / `browse_parts` | 按型号或关键词搜索器件；按类别和参数（耐压、颜色、间距等）筛选 |
| `import_part` | 按料号导入真实封装和引脚，返回焊盘位置 |
| `render` | 把 PCB / 原理图 / 仿真波形输出成 PNG |
| `export_fab` | 导出 `gerbers.zip`、`bom.csv`、`cpl.csv`、STEP 3D 模型（给机械 CAD 做外壳）、KiCad 文件 |
| `export_report` | 生成单文件 HTML 设计报告（图纸、说明、检查、物料、网表），可离线打开、发给他人审阅 |
| `export_3d` | 导出 GLB 3D 模型 |
| `list_versions` / `restore_version` | 每次构建自动存版本，可回滚 |

所有接口（CLI、MCP、HTTP、内置 Agent）共用 `src/tools.ts` 这一张工具表，行为一致。

## 目录

```
src/engine/      编译、分析、导出、器件库、项目与版本
src/tools.ts     工具表（唯一的能力入口）
src/cli.ts       命令行
src/mcp.ts       MCP 服务（stdio）
src/server.ts    HTTP API + SSE + 静态页面
src/agent.ts     内置对话 Agent（Claude Messages API）
src/guide.ts     给 Agent 的设计指南
web/             前端（Vite + React + Tailwind + shadcn/ui）
templates/       已验证的模板板子（测试会逐个构建）
tests/           端到端测试：bun test tests
skills/agenteda  给外部 Agent 的 Skill
projects/        你的项目（每个项目一个文件夹，生成物在 .aeda/）
```

## 能力边界

- 自动检查覆盖连通性、几何规则和几条常见的电气规则，**不能证明电路功能正确**。下单前请人工复核电源、上下拉、去耦和引脚定义。
- 布线器适合双层、约 100 个器件以内的板子。实测 33 个器件、QFN-56 的 RP2040 板能布通，但过孔多、走线绕，去耦电容没法紧贴引脚；没有差分对和等长布线。高速、射频、阻抗控制、多层板不在当前范围内。
- 器件搜索、料号匹配、价格查询依赖在线目录服务；离线时可用 `build --no_parts`，但 `<connector standard="usb_c">` 这类需要在线封装的器件无法编译。
- 导出的 Gerber 通过了第三方解析器的回读校验，但尚未经过真实打样验证，首次下单前请在嘉立创的预览里核对每一层。
- STEP 模型用 OpenCascade 内核实测可以加载（ESP32-C3 板：包围盒 30 × 52 × 12.86 mm，54 个实体，尺寸与设计一致），但还没有在具体的机械 CAD 软件里做过装配。
- 仿真使用理想器件模型，只覆盖阻容感、二极管、三极管等分立器件；没有 SPICE 模型的芯片和模组不参与仿真。
- 内置对话 Agent 的三种引擎验证程度不同：Codex 已用真实对话跑通（多轮、续接会话、改设计、构建、导出）；Claude Code 只验证到“启动、加载工具、未登录提示”这一步，登录后的完整对话没有实测；Anthropic API 只用脚本化的替身模型（`scripts/mock-llm.ts`）验证过。
- 用 Codex 时它运行在只读沙箱里并被要求只用 AgentEDA 的工具，但它的 shell 工具没有被关掉，理论上仍能读取本机文件。Claude Code 则完全没有内置工具。

## 安全说明

- 板子的设计文件是会被执行的 TypeScript 代码。构建在独立子进程里运行并有超时，但**没有沙箱**：它拥有当前用户的全部权限。只构建你信任的来源（你自己或你授权的 Agent）写的设计。
- 服务默认只监听 `127.0.0.1`，没有登录鉴权。它会拒绝来自其他网站的请求（校验 Origin 和 Host，带正文的请求必须是 JSON），所以你浏览的网页无法驱动它；但仍然不要把端口暴露到公网或不可信的局域网。
- API Key 以明文保存在项目目录的 `.aeda-config.json`（权限 600，已加入 `.gitignore`）。

## 没有登录任何模型时怎么看对话效果

```bash
bun scripts/mock-llm.ts
```

然后在“设置”里把 API 地址填成 `http://127.0.0.1:4599`，密钥随便填。这是一个脚本化的替身，会重放一段固定的设计过程（写板子 → 构建报错 → 修复 → 导出），用来演示和测试界面，**不是真实模型**。

## 基于

[tscircuit](https://github.com/tscircuit/tscircuit)（MIT）提供电路编译、自动布线和导出；器件数据来自 [jlcsearch](https://github.com/tscircuit/jlcsearch) 与 EasyEDA。

## 许可证

[MIT](LICENSE)。
