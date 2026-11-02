# Router：私有运行时与指挥台（设计）

状态：**设计（未实现）**　日期：2026-11-01
决策：[ADR-0004](../adr/adr-0004-private-router-runtime.md)　关联：[architecture.md](../architecture.md)、[ADR-0001](../adr/adr-0001-observational-first.md)、[workbench-flow.md](workbench-flow.md)、[event-contract.md](event-contract.md)

---

## 1. 这是什么

**Router 是 mo 自己的主 Agent**：常驻、有模型、只做分派，不做具体工作。它在界面上叫「指挥台」。

它不是 Worker：Worker 是用户自己的 Agent，mo 只观察与派单（ADR-0001）。Router 是 mo 私有安装的第二套运行时（ADR-0004），用户不需要知道它是 Pi 还是 DSH。

### 术语

| 词 | 含义 | 不要混用 |
|---|---|---|
| Router / 指挥台 | 产品概念：那个常驻的主 Agent | 不是「会话」，也不是某个厂商 |
| runtime | Router 的运行时实现（`pi` / 未来 `dsh`） | 不是用户装的 Agent |
| workbench | Router 的 cwd，`~/.mo-agent/router/workbench/` | 不是项目目录 |
| worker | 用户在项目里跑的执行 Agent | 不是 Router 的子会话（v1 无此关系） |
| `role: "router"` | 会话在 hub 里的身份标记 | 不是 agent 类型，agent 仍然是 `pi` |

## 2. 目标与非目标

### 目标

- 一条命令/一个入口拉起 Router：`mo router start`（或设置页「指挥台」）。
- Router 的**工具面在启动参数上收窄**，不依赖提示词约束。
- Router 的运行时**版本由 mo 锁定**，用户升级自己的 Agent 不影响它。
- 换 runtime 只改一个字段，用户不可见。
- 凭据只存一份、可轮换、可删除、不落进运行时配置目录。
- 对话里的过程文档能被留痕：Router 只通过 `note_write` 落笔，产物在 `~/.mo-agent/notes/`（§5.4）。

### 非目标

- 不做 Router 的自动化驱动（Trigger / Watchdog）——那是事件平面那一期；
- 不做多 Router 实例（v1 单实例）；
- 不做自研对话界面（v1 借用运行时自身的 TUI，见 §14 的债）；
- 不改 `adapters/`：Worker 平面的行为一行不动。

## 3. 目录与文件

沿用仓库的两分法（程序产物 vs 用户数据，见 [architecture.md](../architecture.md) §7）：

```
<runtimeRoot>/routers/pi/1.3.0/         # 程序产物：只读、可重建、保留上一版
├── bin/pi                              # 启动器
└── ...                                 # 运行时自带内容

~/.mo-agent/router/                     # 用户数据，跟人走
├── config/                             # PI_CODING_AGENT_DIR 指向这里
│   ├── settings.json  models.json  mcp.json
│   └── extensions/mo-agent-control.js  # 控制桥（prompt / cancel）
├── sessions/                           # PI_CODING_AGENT_SESSION_DIR
├── workbench/                          # cwd
│   ├── README.md                       # 「这是指挥所，不是工地」
│   └── ROUTER.md                       # 契约正文（由 render 生成）
├── credentials.json                    # 0600，不含于任何 git 仓库
└── router.json                         # 状态与身份，不含 key

~/.mo-agent/notes/                      # 过程文档，跟人走（与 memory/ ledger/ 同级）
└── 2026-11-01-<slug>.md                # 由 note_write 落盘，见 §5.4
```

`runtimeRoot` 复用 `docs/plans/desktop-cross-platform.md` 里规划的 `platformPaths.runtimeRoot`：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/mo-agent/routers/` |
| Windows | `%LOCALAPPDATA%\mo-agent\routers` |
| Linux | `$XDG_DATA_HOME/mo-agent/routers/`（默认 `~/.local/share/...`） |

**从第一天就用版本化目录。** 升级时新目录落盘成功再切 `router.json` 的 `version`，失败保留旧版可回滚。

### router.json

```json
{
  "v": 1,
  "onboarded": true,
  "runtime": "pi",
  "version": "1.3.0",
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "sessionId": "mo-router",
  "pid": 51234,
  "cwd": "/Users/x/.mo-agent/router/workbench",
  "startedAt": "2026-11-01T10:00:00.000Z"
}
```

`onboarded` 用来把「没引导过」和「起不来」区分开：前者跳设置页，后者报错码。
**任何情况下都不写 key。**

### 文件权限

`credentials.json`、`router.json` 一律 `0600`，写法照抄现有 house style：写临时文件 → `chmod` → `rename`（`host/dingtalk-setup.mjs:65`、`host/dingtalk-bot.mjs:104`）。非 POSIX 平台上 `chmod` 失败忽略。

## 4. 启动流程

### 4.1 首次（未引导）

| 步 | 做什么 | 失败 |
|---|---|---|
| R1 | `mo router start` → 读 `router.json`，`onboarded` 为假 | 返回 `E_ROUTER_NOT_ONBOARDED`，并给出设置页链接 |
| R2 | 设置页「指挥台」选 provider + model（默认给轻量档） | — |
| R3 | 凭据：粘贴，或「用本机已有的」（检测到才显示） | `E_ROUTER_NO_CREDENTIAL` |
| R4 | **测通**：真实发一条短消息，界面上看到回复 | `E_ROUTER_START_FAILED`（带原始错误） |
| R5 | 安装 runtime 到 `routers/<id>/<version>/`（下载 → sha256 校验 → 同目录 rename） | `E_ROUTER_RUNTIME_MISSING` |
| R6 | 写 `config/`、`sessions/`、`workbench/`（README + ROUTER.md） | — |
| R7 | 写 `credentials.json`（0600）、`router.json`（`onboarded: true`） | — |
| R8 | 启动进程、注入 hub | `E_ROUTER_START_FAILED` |
| R9 | 显示状态与成本档位 | — |

**R4 不能省。** 首次体验里最挫败的是「显示启动了，但 key 是错的」。

### 4.2 引导入口：mo setup 与 mo router setup

CLI 入口：**裸 `mo router` 就等同于 `mo router start`**（默认子命令，和 `mo upgrade` / `mo mcp` 一致），不必记两层。

两条路都能完成「装运行时 + 配 provider/model/key」，共用同一套实现：

| 入口 | 适用 | 行为 |
|---|---|---|
| `mo setup` 的「指挥台」步骤 | 首次装配，一次配齐 | 交互时先问一句再装；**非交互必须显式 `--router`**，不会因为 `--yes` 就下载 150MB；`--dry-run` 只输出计划 |
| `mo router runtime install` + `mo router setup` | 已装配过，只重配指挥台 | 直接执行，不连带其它步骤 |

两者都走 `--router-provider/-model/-key` 或环境变量；测通默认开启（`--no-test` 跳过），失败时配置仍保留但标 ⚠，不假装成功。

### 4.3 再次

读 `router.json` → 有活着的 pid 且健康 → 直接 attach（打印入口）；否则按 R5–R9 起。**单实例**，第二个 `start` 不新起进程。

### 4.4 错误码

| 码 | 含义 | 下一步 |
|---|---|---|
| `E_ROUTER_NOT_ONBOARDED` | 没引导过 | 打开设置页「指挥台」 |
| `E_ROUTER_NO_CREDENTIAL` | 有配置无凭据 | 同一入口补填 |
| `E_ROUTER_RUNTIME_MISSING` | 运行时未装或损坏 | `mo router runtime install` |
| `E_ROUTER_RUNTIME_UNSUPPORTED` | 运行时能力不满足准入（见 §5.2） | 换 runtime，或先给 mo 加闸门 |
| `E_ROUTER_ALREADY_RUNNING` | 已有实例（仅 `start --new` 时） | 先 `stop` |
| `E_ROUTER_START_FAILED` | 进程起不来 / 测通失败 | 看 `~/.mo-agent/router/start.log` |
| `E_ROUTER_UNHEALTHY` | pid 在但不应答 | `mo router restart` |
| `E_ROUTER_SESSION_MISSING` | hub 里找不到 Router 会话 | 重启；持续出现则是注入故障 |

## 5. 能力面：工具、文档与记忆

**总原则：读能力可以由 runtime 提供；写能力只能由 mo 提供。**

runtime 只给只读工具；所有副作用（写文档、提记忆、建卡派单）统一从 mo 的 MCP 工具走。这样换 runtime 时 Router 的能力面完全一致，落点、权限与审计也留在 mo 里。

**Router 不加载技能（`--no-skills`）。** 它的契约是 `ROUTER.md`（`--append-system-prompt`）；通用 `mo` 技能里全是 shell 命令示例，而 Router 没有 shell，技能发现又是全局的（含 `~/.agents/skills`），不显式关掉就会被误导。

### 5.1 只读白名单（runtime 提供）

```
read, grep, find, ls, mcp__mo__*
```

- `read / grep / find / ls`：只读。Router 需要能自己搜代码、定位问题，否则判断"该不该派单"的质量会明显下降。
- `mcp__mo__*`：mo 的 8 个契约工具（`core/manager/contract.mjs` 的 `TOOLS`）。
- **不给** `bash` / `edit` / `write` / `powershell`。

| 为什么给 | 为什么不给 |
|---|---|
| `read` 本来就能读工作目录外，多几个只读工具不增加破坏面 | `bash` 是"手"：有了它 Router 会自己上手改代码，§7.1 实验证明提示词拦不住 |
| 搜代码能显著提高分派质量 | `edit/write` 让 Router 与 Worker 争同一份工作区，冲突无人仲裁 |
| 白名单同时挡住全局 `mcp.json` 里的其它 MCP 工具 | 需要执行时，正确动作是**派单**，不是自己跑 |

### 5.2 准入规则（fail-closed）

运行时接口必须声明：

```js
capabilities: {
  toolRestriction: "allowlist" | "preset" | "none",
  prompt: true, cancel: true,
  ui: "tui" | "none",
  sessionIsolation: true
}
```

- `allowlist`：可按名字精确白名单 → 允许上岗；
- `preset`：只能靠运行时预设的粗粒度工具集 → 允许上岗，但 `mo router status` 必须标注「工具面为预设粒度」；
- `none`：无法限制 → **拒绝启动**（`E_ROUTER_RUNTIME_UNSUPPORTED`），除非 mo 侧已有拦截实现。

这条是地基：**"Router 没有手"不能靠提示词，只能靠启动参数或硬闸门。**

### 5.3 写能力（全部由 mo 提供）

| 工具 | 副作用 | 落点 | 现状 |
|---|---|---|---|
| `task_create` / `task_confirm` / `task_dispatch` | 建卡、发起确认、派单 | 项目内 `.mo-agent/` | ✅ 已有 |
| `memory_propose` | 记忆候选 | `~/.mo-agent/memory/candidates/` | ✅ 已有 |
| `note_write` | 过程文档 | `~/.mo-agent/notes/` | ❌ 待新增 |

三者的共同点：**都不接受任意路径**，落点由 mo 决定。Router 永远没有"写这个文件"的能力，只有"记这一笔"的能力。

### 5.4 落文档：note_write

对话里会产生三类东西，归属不同：

| 类型 | 例子 | 谁落盘 | 落哪 |
|---|---|---|---|
| 对话本身 | 这轮聊了什么 | 运行时自动写 | 运行时 sessions |
| 过程文档 | 讨论纪要、方案草稿、"刚定的结论" | **Router 自己** | `~/.mo-agent/notes/` |
| 交付物 | 方案、报告、代码、项目文档 | **Worker**（派单） | 项目目录 |

过程文档是唯一**必须 Router 自己写**的一类：Worker 不在对话现场，拿不到这轮的上下文。

```
note_write({ title, slug?, body, tags? }) -> { ok, path, id }
```

| 约束 | 值 |
|---|---|
| 落点 | 固定 `~/.mo-agent/notes/YYYY-MM-DD-<slug>.md`，**不接受路径参数** |
| slug | 仅 `[a-z0-9-]`，≤ 64 字符；缺省由 title 生成 |
| 同日同 slug 重复 | **不覆盖**，自动加序号（`-2`、`-3`…），保持 append-only |
| 单篇上限 | 64KB，超了返回 `E_NOTE_TOO_LARGE`，由 Router 自己拆 |
| 删除 / 编辑 | 不提供。要改就再写一版 |
| 审计 | 每次落盘记账本 `note.written`（path / bytes / title / owner=router） |

**为什么放在 `~/.mo-agent/notes/` 而不是 workbench 下**：和 `memory/`、`ledger/` 同级、跟人走。换机器、换 runtime 都还在。

### 5.5 记忆：只提案，不写库

现有的两段式不动：Router 只能写 `candidates/`，人 `mo memory accept` 才入库（`core/manager/contract.mjs` 的 `FORBIDDEN` 已排除 `memory_accept`）。

**Router 是最合适的提案者**：Worker 各自隔离，看不到"同一个坑第三次出现"；Router 跨项目跨任务，天生在那个位置上。

但 Router 高频提案后会立刻暴露三个缺口，实现时必须一起补：

| 缺口 | 现状 | 要补 |
|---|---|---|
| 被拒的候选不留账 | `workbench-flow.md` §7 明写"被拒的候选不留账" | 至少记 `memory.rejected`，否则 Router 会反复提同一条 |
| 没有配额 | — | 契约里给硬上限：一次对话最多 2 条 |
| 去重只查 pending | `saveCandidate` 按同 scope + 同标题查 | 入库后的相似靠 B10.4 的 0.6 阈值兜；Router 提案频繁时需复核该阈值 |

### 5.6 分界线与召回

**notes 还是 memory，只看一句：下次要不要改变我的行为？**

- 要 → `memory_propose`（进候选，人裁决，参与派单注入）；
- 不要、但值得留给人看 → `note_write`。

**notes 不参与自动召回。** 派单注入只扫 `memory/`。理由是注入过多会挤占窗口、稀释注意力；Router 要翻旧笔记，用 `grep` / `read` 显式去找。

**要写进项目文档怎么办：派单。** 不开例外。守住一条极简不变量：**Router 永远不碰项目工作区**。一旦它能往项目里写，就会和 Worker 争同一份文件，而冲突无人仲裁。代价是"写一篇文档也要建卡"，但那一下确认恰好是想要的——文档也是交付物，也该被验收。

## 6. 会话注入

### 6.1 注入路径

Router 会话**不经过 `adapters/`**。host 在 spawn 之后直接：

```
hub.emit(session.upsert, {
  id: "mo-router", role: "router",
  agent: "pi", agentLabel: "指挥台",
  cwd: "~/.mo-agent/router/workbench",
  capabilities: { prompt: true, cancel: true }
})
```

这样依赖方向是干净的：Worker 走 `adapters/`（观测），Router 走 `cli/lib/router-*`（自持），两条路径互不引用。

### 6.2 与 Pi adapter 的去重

Pi adapter 靠进程表 + 会话文件可能也看到这个进程。约定：

- Router 的 `--session-id` 固定为 `mo-router`，会话文件落在 `sessions/--<workbench 路径 slug>--/`；
- 两条路径若都产生会话，**用同一个 id**（`mo-router`），`hub.normalize` 的 upsert 语义自动合并，不产生重复条目；
- `role` 一旦是 `router`，**不因后续 upsert 被覆盖成 `unknown`**（`normalize` 里对 `role` 做保留）。

### 6.3 对现有代码的改动

| 文件 | 改动 |
|---|---|
| `core/contract.mjs` | `session` 事件增加 `role` 字段，默认 `"unknown"`；可选值 `router / worker / unknown` |
| `core/hub.mjs` | `normalize` 保留既有 `role`；`list()` 支持按 `role` 过滤 |
| `host/http.mjs` | `/api/prompt`、`/api/cancel` 对 `role: "router"` 放行（`canControl` 依据） |
| `app/web` | 监控页把 Router 单独渲染成一张卡，不混在 worker 列表里 |

## 7. 凭据

### 7.1 存储

```json
{ "v": 1, "provider": "deepseek", "apiKey": "sk-...", "updatedAt": "..." }
```

`0600`；不进任何 git 仓库；日志与界面一律脱敏（只显示后 4 位）。

### 7.2 注入方式

**不写进运行时的配置目录。** 启动时映射成环境变量：

| provider | env |
|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| 其它 | 运行时支持 `--api-key` 时走参数，否则该 provider 不支持 |

映射表放在 `cli/lib/router-credentials.mjs`，**换 runtime 时只换这张表**。好处：删凭据只删一个文件；配置目录里永远没有秘密；不会因为运行时改了 auth 格式而断。

### 7.3 轮换与删除

- 换 key：设置页改 → 重启 Router（`mo router restart`）；
- 删：删 `credentials.json` + `mo router stop`，`router.json` 的 `onboarded` 置假。

## 8. 契约 ROUTER.md

由 `core/manager/contract.mjs` 的 `render({ role: "router" })` 生成，与 worker 版共用同一真源。Router 版必须说清：

1. 你在 `~/.mo-agent/router/workbench`，**不在任何项目里**；不要在这里构建、测试、改代码。
2. 你**没有 shell、不能写文件**（只有 `read/grep/find/ls` 和 mo 的工具）。这不是故障，是设计。
3. 派单必须指明项目：`task_create` 带 `project`（`mo project list` 看全部）。
4. 你的记忆跨项目（`~/.mo-agent/memory/`）。
5. 每次对话开始先 `inbox_pull`：有卡在等你裁决。
6. 不要绕过 mo 去操作项目。

## 9. HTTP 接口

全部要求本机令牌（与现有 `/local/*` 同级），局域网/外网 403。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/local/router/status` | 运行状态、runtime/version、模型、pid |
| POST | `/local/router/setup` | 提交 provider / key / model（引导） |
| POST | `/local/router/test` | 测通（R4） |
| POST | `/local/router/start` | 启动（含首次安装） |
| POST | `/local/router/stop` | 停止 |
| POST | `/local/router/restart` | 重启 |

## 10. 生命周期与单实例

**pid 归"启动它的那个进程"，host 只做接管。** 这条在 [cli 分层重构](../plans/cli-layer-split.md) 后落地：

- `mo router` 的**所有**动作（start / stop / status / setup / runtime）都在本地完成，不经 HTTP、不需要 host 在场；
- host 启动时调 `adoptRouterSession()`：读 `router.json` + `router.pid`，发现 Router 活着就注入 hub、接上控制面，**不重启它**；Router 里的 Pi 控制扩展在拿不到 host 时会退避重试（不退出），所以**先起指挥台、后起 host 也能接上**；
- 于是"只装 CLI 也能用指挥台"，手机/监控等远程能力在 host 起来后自动补上。

历史上曾让 host 独占生命周期，理由是"否则 CLI 与桌面 App 会各起一个"。现在用"pid 由启动者写、host 只读 + 可发 SIGTERM"解决同一个问题，不必把所有权交给服务。

**两种形态，默认开窗口，`--foreground` 就地跑。** TUI 需要 tty，detached 进程没有终端可画，所以：

- 默认：`mo router start` 在**当前终端**跑（TTY 下），`--window` 才开新窗口；
- `--start-daemon`：先把 host 起来 → 自动打开监控屏 → 再进 TUI。host 起不来不阻断指挥台（只是丢远程能力），`--no-open` 可跳过开页面；
- `mo router start --foreground`：**在当前终端里跑**，Ctrl-C 即停。这条不经过 host（前台只对当前终端有意义）；
- `--mode rpc` 的无窗口形态留到下一期。

**密钥不写进启动脚本。** `start.sh` 是 0644 且只负责 pid/cd/exec，凭据放在单独的 `secrets.sh`（0600），**只在运行期间存在**，`stop` 与前台退出都会删掉。`credentials.json` 仍是唯一事实源。

其余照抄 `cli/commands/daemon.mjs` 的既有模式，**不要发明第二套**：

- pid 文件：`~/.mo-agent/router/router.pid`；
- 健康检查：`/local/router/status` 或（进程存活 + session 在 hub 里）；
- 日志：`~/.mo-agent/router/router.log`（终端窗口里的输出另有一份，两者不互斥）；
- 崩溃：**不自动无限重启**。重启 3 次仍失败则停在 `E_ROUTER_UNHEALTHY` 并在监控页告警——否则会在错误的凭据上反复烧钱。
- `stop` 先 SIGTERM，5 秒后 SIGKILL（同 daemon）。

## 11. 升级与回滚

- 版本 pin 在代码里的 `cli/lib/router-runtimes.mjs`（随 mo 版本走），**不是 latest**；
  **必须是 JS 模块而不是 JSON**：单文件二进制（`bun --compile`）只内联 JS 模块，运行时读外部 JSON 会拿到不存在的 `/$bunfs/...` 路径；
- 安装方式：`npm install --prefix <staging>` 装进临时目录，用**私有 npm cache**（`<runtimeRoot>/npm-cache`），
  避免用户 `~/.npm` 损坏时把安装拖下水；自检通过后 `rename` 到最终目录，失败不留半个安装；
- Node 下限来自运行时清单（Pi 1.3.0 要求 `>=22.19.0`），由安装器负责找并钉进 `bin/pi` 的 shim；
- 升级：下载到 `routers/<id>/<new>/` → 校验 → 写 `router.json.version` → 重启；旧版目录保留；
- 回滚：把 `version` 改回旧值 + 重启；
- `mo router runtime prune` 清理旧版本；
- 禁止在私有 runtime 目录里执行运行时自带的 `update` 命令——升级只能走 mo。

## 12. 监控与成本

监控页固定一张「指挥台」卡：

- 在跑 / 停止 / 异常；
- runtime + version（**只有排查时才对用户有意义**，默认折叠）；
- 模型名；
- 本月用量与大致费用；
- 一键停止。

用户不需要知道它是 Pi，但必须能看见它在花他的钱。

## 13. 验收清单

- [ ] 首次 `mo router start` 打开设置页并完成引导，测通后进程起来；
- [ ] `router.json` 存在且 **不含 key**；`credentials.json` 权限 `0600`；
- [ ] Router 进程的工具面实测只有 `read/grep/find/ls` + mo 的 8 个工具（让它尝试 `bash`，应报工具不存在）；
- [ ] 要求它改代码时，它**派单**而不是自己写；
- [ ] Router 没有 `write/edit/bash`；落文档只能走 `note_write`，产物出现在 `~/.mo-agent/notes/`；
- [ ] 同日同 slug 写两次 → 自动出现 `-2` 后缀，**旧文件未被覆盖**；
- [ ] 单篇超过 64KB → `E_NOTE_TOO_LARGE`；
- [ ] `notes/` 不参与派单知识注入（recall 只扫 `memory/`）；
- [ ] Router 会话出现在 hub 且 `role: "router"`；Pi adapter 不产生重复条目；
- [ ] 手机/钉钉/语音能通过 `/api/prompt` 给 Router 发指令；
- [ ] 第二个 `mo router start` 是 attach，不新起进程；
- [ ] 删掉 `credentials.json` 后启动得到 `E_ROUTER_NO_CREDENTIAL`，不是静默失败；
- [ ] 在 `runtimes.mjs` 里加一个 `toolRestriction: "none"` 的假 runtime，得到 `E_ROUTER_RUNTIME_UNSUPPORTED`；
- [ ] `npm test`、`npm run check` 通过；Worker 平面行为零变化。

## 14. 不做

- 不做 Router 的 Trigger/事件自动驱动；
- 不做多 Router 实例；
- 不做自研对话界面（v1 借 TUI）；
- 不改 `adapters/`、不改 Worker 平面任何行为；
- 不把 Router 做成"带数据库的云端服务"（持久化那一期再说）；
- 不把 `notes/` 做成第二个记忆库（它不参与召回，也不代替 `memory/`）；
- 不允许 Router 直写项目工作区（要写就派单，无例外）。

### 记录在案的债

**界面归属。** v1 借运行时自带的 TUI。界面属于运行时，换实现界面就变，用户立刻会发现"换了东西"——这与"用户不需要知晓"冲突。终态必须由 mo 提供界面（Pi 的 `--mode rpc` 无 TUI 但协议最全，正是为此准备）。**这条债必须在第一次换 runtime 之前还清。**

## 15. 待验证假设

实现前必须逐条实测，不要照文档写代码：

| # | 假设 | 怎么验 |
|---|---|---|
| A1 | `--tools 'read,grep,find,ls,mcp__mo__*'` 的语义与帮助文本一致（含 `mcp__` 条目才把 MCP 也纳入白名单） | 起一个 Router，让它列可用工具。**已部分实测**：私有配置目录 + `mcp.json` 下 `pi mcp list` 返回 `mo: connected, 8 tools`；`--tools` 对该模式是否放行仍未验 |
| A2 | 独立 `PI_CODING_AGENT_DIR` 下 Pi 缺 `bin/fd`、`bin/rg` 时 `grep`/`find` 是否降级或自动下载 | 空配置目录起一次，观察网络与报错 |
| A3 | `PI_OFFLINE=1` 只关启动期网络操作，不影响模型调用 | 设该变量后跑一次对话 |
| A4 | 私有 install 里的启动器不会因 `PI_CODING_AGENT_DIR` 变化而找不到自身 release | 换目录后 `--version` |
| A5 | mo 控制桥扩展在私有配置目录下能被 `-e` 正常加载并发 `prompt` | 装到 `config/extensions/` 后实测手机发指令 |
| A6 | 同一个 `--session-id` 被 host 注入与 adapter 观测时，hub 不产生两条记录 | 起 Router 后看 `/api/sessions` |
