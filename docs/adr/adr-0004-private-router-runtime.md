# ADR-0004：私有 Router 运行时（两个平面，两套运行时）

状态：**已采纳（方向已定，尚未实现）**　日期：2026-11-01
扩展：[ADR-0001 观察优先](adr-0001-observational-first.md)（不取代，见 §「与 ADR-0001 的关系」）
落地设计：[spec/router.md](../spec/router.md)
背景研究：[research/super-agent-architecture-analysis.md](../research/super-agent-architecture-analysis.md)

## 背景

研究结论是：mo 已经具备 Super-agent 的大部分周边（统一事件契约、真实工作信道、派单与验收闭环），缺的是**中枢**——一个常驻、有模型、不干活、只做分派的 Router。三个配套（Trigger 语义过滤、Thread 订阅、上下文引用图）都不需要模型能力，是数据结构与路由表。

设计讨论中暴露出一个更基础的问题：**mo 现在把「对话的位置」和「执行的位置」绑成了同一个 cwd**。

- 主 Agent 必须在项目目录里对话，否则每条命令都会撞 `E_PROJECT_UNBOUND`；
- 卡片、回执、日志按项目存放（这是对的——执行者的 cwd 在那儿），但它反过来要求对话也停在那儿；
- 结果是一个 Agent 同时当 Router 和 Worker，而 cwd 逼它当 Worker。

这与文章 §2 的诊断是同一句话：Session 同时承载了技术上的上下文管理与面向用户的项目管理。放到 mo 上，就是 **cwd 同时承载了对话位置与执行位置**。

要修，就得决定 Router 用谁的运行时。两条路：

1. **寄生**：用用户已装的 Pi / DSH。省安装，但 Router 的配置、扩展、凭据、启动参数语义全都变成"用户机器状态的函数"——用户 `pi update` 一次，Router 行为就可能变。
2. **私有**：mo 自己持有一个受控版本的运行时。多一次安装，换来可重现、可替换、可干净卸载。

## 决策

**采纳私有 Router 运行时，并明确划分两个平面。**

1. **两个平面**
   - **Worker 平面**：用户的 Agent（Claude Code / Pi / DSH / Qoder…），官方安装、官方升级，mo 只观察与派单。ADR-0001 的观察优先**在这一平面继续全额有效**。
   - **Router 平面**：mo 自己的 Agent 运行时，私有安装、版本锁定、可替换。用户不需要知道它是 Pi 还是 DSH。

2. **运行时私有安装、版本化**
   `<runtimeRoot>/routers/<id>/<version>/`，只读、可重建、保留上一版供回滚；`~/.mo-agent/router/router.json` 只记 `runtime` 与 `version`。换实现 = 改一个字段 + 重装。

3. **能力面：读由 runtime 给，写由 mo 给；准入 fail-closed**
   - Router 只拿到只读工具 `read, grep, find, ls` + `mcp__mo__*`；`bash / edit / write / powershell` 一律不给。
   - **所有副作用（建卡、提案、落文档）只能从 mo 的 MCP 工具走**，不接受任意路径。Router 永远没有"写这个文件"的能力，只有"记这一笔"的能力。这条让能力面不随 runtime 变化——换实现时 Router 会的还是那些。
   - 抽象层暴露 `capabilities.toolRestriction`（`allowlist` / `preset` / `none`）：**值为 `none` 的运行时不得作为 Router 启动**，除非 mo 侧另有拦截。抽象层不许假装两个运行时能力相同。

4. **凭据由 mo 持有，引导一次**
   `~/.mo-agent/router/credentials.json`（`0600`），启动时通过环境变量注入运行时，**凭据永不落进运行时的配置目录**。不静默复制用户已有凭据；检测到可以提示，但复用必须由用户点一次。

5. **Router 会话由 host 直接注入 hub**
   `role: "router"`，会话 id 固定 `mo-router`。不经过 `adapters/`——Router 是 mo 自己 spawn 的，它手里有 pid / sessionId / cwd，不需要探测。

6. **Router 的 cwd 固定为 `~/.mo-agent/router/workbench/`**
   一个空目录也要有，因为它宣告"这里是指挥所，不是工地"。

## 结果：能力边界

| 得到 | 代价 |
|---|---|
| Router 行为可重现：运行时版本由 mo pin，不受用户升级影响 | 首次启动要装一个运行时（几 MB～几十 MB） |
| 实现可替换：Pi → DSH 只换 runtime + 一个字段 | 抽象层要处理能力不对称，不能只写一个薄壳 |
| 用户全局配置零污染：不用碰 `~/.pi/agent/`，不需要项目 trust 技巧 | 需要自己维护运行时的安装、校验、升级、回滚 |
| 卸载干净：删一个目录 | — |
| 用户不需要知道它是 Pi 还是 DSH | **但必须知道它在**：设置页有入口、监控有卡片、可停可删、成本可见 |

**必须偿还的债（记录在案）**：v1 借运行时自带的 TUI 当对话界面。但界面属于运行时，一旦换实现界面就变，用户立刻会发现"换了东西"。**终态必须由 mo 提供界面**（Pi 的 `--mode rpc` 无 TUI 但协议最全，正是为此准备的）。这条写在这里，避免 v1 被当成终态。

## 关键设计约束：两个平面的失败策略相反

ADR-0001 定的规则是「不 fail-open，也不宜 fail-closed，交回本地终端」。**这条只适用于 Worker 平面。**

| 平面 | 失败时 | 理由 |
|---|---|---|
| Worker | fail-open，交回用户的终端 | 用户的终端就是降级界面，Agent 不能因为 mo 挂了而卡死 |
| Router | **fail-closed，拒绝启动** | Router 没有降级界面；一个带手的 Router 比"启动失败"危险得多 |

同理：凭据缺失、运行时校验失败、`toolRestriction === "none"` —— 全部拒绝启动并给出可执行的下一步，不允许"先起来再说"。

## 被否决的替代方案

- **复用用户已装的 Pi / DSH 当 Router**：无需安装，但 Router 的行为变成用户机器状态的函数；`--tools` 这类 CLI 契约随用户升级漂移；用户卸载那个 Agent，Router 就消失。
- **静默复制用户凭据**：省一次引导，但把 Router 的身份绑在另一款产品上（对方改 auth 格式就断），并制造一份用户不知情的凭据副本。
- **Router 带 Bash，用提示词约束它别自己干**：`research/super-agent-architecture-analysis.md` §7.1 的实验已经证明会漏——5 次里 1 次模型自判"这事很小"就亲自做了。
- **mo 自研 ReAct 运行时**：重复 DSH 的工作，并且会填掉"跨 Agent 中立"这个唯一的护城河。

## 与 ADR-0001 的关系

**不取代，是给它加一个平面限定。**

ADR-0001 的核心承诺"不托管用户的 Agent、不改变它的运行方式"针对的是 Worker 平面，继续全额有效：hook 优先级、能力矩阵、失败策略、每家一个 profile 的维护模型都不变。

本 ADR 只声明一件事：**Router 是 mo 自己的 Agent，不是用户的 Agent，因此不受"不托管"约束。** 两个平面在依赖方向上是分开的——Router 走 `host/`，Worker 走 `adapters/`，互不引用。

## 保留的扩展点

- `host/router/runtime.mjs` 的运行时接口（`ensure` / `start` / `stop` / `status` / `prompt` / `cancel` + `capabilities`），第二个实现直接加文件；
- Router 的写能力全部是 mo 侧的 MCP 工具（`task_*`、`memory_propose`、新增 `note_write`），**不随 runtime 变化**；将来加新的写能力也只加在 mo 这一侧；
- Router 界面：v1 TUI → v2 mo 自建；
- 多个 Router 实例：按上下文共享/隔离边界划分（对应研究文章 §8.3），v1 明确不做；
- Router 的自动化驱动（Trigger / Watchdog）：属于事件平面那一期，不在本 ADR 范围。
