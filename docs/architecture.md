# 架构总览

状态：与当前代码（0.3.0 + Router）一致　日期：2026-11-01
关联：[ADR-0001 观察优先](adr/adr-0001-observational-first.md)、[ADR-0003 事件契约](adr/adr-0003-event-contract.md)、[ADR-0004 私有 Router 运行时](adr/adr-0004-private-router-runtime.md)、[事件契约](spec/event-contract.md)

## 1. 这是什么

Mo Agent 有两个面：

- **监理**（观察优先）：观察本机各个 Agent 的会话，归一成一套领域事件，在你真正需要决定的那一刻（授权、提问、完成、失败）把消息递到你面前，并支持远程批准与指令。它**不托管用户的 Agent、不改变其运行方式**（ADR-0001）。
- **工作台 + 指挥台**（应用内核）：任务卡、批准、派单、回执、账本，以及 mo 自己的主 Agent（Router）。这一面**以文件为状态，可以完全脱离常驻服务运行**（ADR-0004）。

这两条决定了整个架构：观测靠 adapter（不改造对方），流程靠 CLI（不依赖服务）。

## 2. 分层

四层，加两类旁挂：

```
                   用户面（不写业务逻辑）
   app/web · app/android        desktop 菜单栏      手机 · 钉钉 · 耳机
          │ HTTP/SSE                  │ 子进程 / 推送        │
          ▼                           ▼                     ▼
   ┌──────────────────────────────────────────────────────────┐
   │                          host                            │ 常驻进程
   │  适配器调度 · HTTP/SSE · 配对 · 批准页 · 钉钉 · 推送 · 语音  │ 观测 + 信道
   └────────▲──────────────────────────────▲──────────────────┘
            │ import                       │ import
   ┌────────┴─────────┐          ┌─────────┴──────────┐
   │    adapters      │          │        cli         │ 应用内核
   │ 厂商信号→领域事件 │          │ 卡/批准/派单/回执/账本 │ 可独立运行
   └────────┬─────────┘          └─────────┬──────────┘
            │                              │
            └──────────────┬───────────────┘
                           ▼
                   ┌───────────────┐
                   │     core      │ 纯逻辑：事件契约·状态机·通知策略·Router 策略
                   └───────────────┘

   旁挂：approvals（hook 入口，只依赖 core）· hooks（配置模板，无代码）
        integrations（Pi 扩展，注入运行时）· scripts（构建/安装）· desktop（壳）
```

**一句话判据**：`core` 不认识任何人；`cli` 只认识 `core`；`host` 认识下面三层；`app/desktop` 只跟 `host` 说话（HTTP 或子进程）。

## 3. 目录职责

| 目录 | 职责 | 边界 | 实测代码量 |
|---|---|---|---|
| `core/` | **领域核心，纯逻辑**。事件词汇表、Hub 归约、通知策略、任务卡状态机、记忆打分、Router 能力面策略 | **不碰文件、不发网络、不起进程** | 2.2k |
| `cli/` | **应用内核 + 命令行**（按目录分界）：`lib/` 是**内核**（项目、卡、批准、派单、回执、账本、记忆、notes、**Router 的安装与生命周期**），host 可复用；`ui/` 是界面层（argv 解析、输出、help、弃用提示）；`commands/` + `mo.mjs` 是接口层 | 不 import `host/`；退出即止；`lib` 不许 import `ui`/`commands` | 11.1k |
| `host/` | **常驻服务**。HTTP/SSE、鉴权、配对、适配器调度、钉钉 Stream、推送、语音、hooks 写入、批准页；Router 只保留"会话接管 + HTTP 薄壳"（`router-session.mjs`） | 唯一的常驻 IO 层 | 9.8k |
| `adapters/` | **观测层**。把每家 Agent 的原始状态翻译成统一事件；`profiles/*.json` 声明能力 | 只陈述事实，不决定通知文案；不投递 | 2.9k |
| `approvals/` | **审批挂接点**。被 Agent 调用的 hook CLI、决策 broker、厂商事件名映射 | 不直接推送 | 0.5k |
| `app/web/` | 监控页、管理页、审批页、语音浮层、PWA | **只通过 host 的 HTTP/SSE 访问**，不 import 任何后端模块 | 5.0k |
| `app/android/` | Capacitor 原生工程（WebView 包 web 资源） | 同上 | — |
| `desktop/` | ElectroBun 桌面壳：菜单栏、单实例、拉起 host、打包。**`desktop/runtime/` 是 host 运行时的打包副本**（不是源码） | 不含业务逻辑；只做进程与托盘 | 2.1k（壳本体） |
| `hooks/` | 三家 Agent 的 `settings.snippet.json` 模板 | 只是模板，由 host 写入真实配置 | 0 行代码 |
| `integrations/` | Pi 控制扩展（注入到 Pi 进程内） | 只跟 host 的 `/local/pi/*` 说话 | 0.2k |
| `scripts/` | 构建、安装、生成、e2e、发版 | 可以调任何层，但只做工具 | — |

### 3.1 host 内部模块

host 对外只有一条边界："常驻 IO + 外部事件源 + UI 数据面"。对内按职责分七组，新增代码先归组，再决定要不要新起一组：

| 组 | 模块 | 职责 |
|---|---|---|
| 接入 | `index.mjs`、`http.mjs`、`admin-auth.mjs` | 启动、路由、鉴权、SSE |
| 设备 | `pairing.mjs`、`pair-http.mjs`、`push-tokens.mjs`、`hms-push.mjs` | 配对令牌、设备登记、系统推送 |
| 通道 | `notify-webhook.mjs`、`notify-config.mjs`、`dingtalk-*.mjs`、`voice/*` | 把 notify 事件送到人面前 |
| 任务 | `task-approvals.mjs`、`task-watch.mjs` | 任务卡批准（含"允许并派单"）与待批提示 |
| 观测 | `agent-hooks.mjs`、`pi-extension.mjs`、`monitor-http.mjs`、`logs-http.mjs` | hook 写入、Pi 扩展、监控与日志页 |
| 页面 | `settings-page.mjs` | 设置页（安装 / 配对 / 钉钉 / Agent / 语音 / 系统） |
| 壳 | `config.mjs`、`log.mjs`、`log-file.mjs`、`router-session.mjs` | 配置、日志轮转、指挥台会话接管 |

**通道统一契约**：任何推送通道只要实现 `{ accepts?(payload), send(payload) }`，就能挂到 `core/notify.mjs` 的 `Notifier`（`register/unregister`）。通道不判断"要不要打扰"——那是 `NOTIFY_POLICY` 与静音时段的事；通道也不碰重试之外的业务状态。

## 4. 一次事件的生命周期

```
1. adapter 观察到一个事实
   → session.upsert / run.completed / pending.approval / pending.question
2. core/hub 归约状态并分发（SSE 只发 event: message）
3. core/notify 查表决定"这算不算需要打扰人"（NOTIFY_POLICY）
4. host 按通道投递：HMS 推送 / 钉钉 / webhook / 语音
5. app/web 与手机按 type 分发渲染
6. 人的决定从 approvals 反向进入
   → hook-cli → broker → decisions → core → 回到 Agent
```

关键规则（详见 [事件契约](spec/event-contract.md)）：**适配器不发通知，状态语义固定，一轮结束先 `session.upsert` 再 `run.*`。**

## 5. 依赖方向

**core → cli → host → 用户面**，加上适配器旁支。实测矩阵（扫全部 `.mjs`，不含测试）：

| 从 \ 到 | core | cli | host | adapters | approvals |
|---|---|---|---|---|---|
| **core** | — | — | — | — | — |
| **cli** | ✅ 63 | — | — | — | — |
| **host** | ✅ 9 | ✅ 8 | — | ✅ 4 | ✅ 4 |
| **adapters** | ✅ 8 | — | — | — | — |
| **approvals** | ✅ 2 | — | — | — | — |
| **app/web** | — | — | HTTP/SSE | — | — |
| **desktop** | — | — | 子进程 | — | — |

| 允许 | 禁止 |
|---|---|
| `cli → core` | `cli → host`（**CLI 必须能独立运行**，host 是它的上层） |
| `host → cli / core / adapters / approvals` | `core → cli / host`（core 不做 IO） |
| `adapters → core` | `adapters → host`（观测层不投递） |
| `approvals → core` | `app/web → core / cli`（前端不直连领域层） |
| `app/web → host (HTTP/SSE)` | `host → desktop`（单向：壳拉 host） |
| `desktop → host (子进程)` | `integrations → host`（走 HTTP，不 import） |

**host 只负责"长期在线 + 外部事件源 + UI 数据面"**：适配器观测、手机/钉钉/语音信道、推送、监控页。除此之外的一切——建卡、批准、派单、回执、账本、Router——都应该在 `cli/` 里闭环，不要求 host 在场。

判定方法：**如果一条命令在没有 host 的情况下跑不通，先问"它真的需要长期在线或外部信道吗"**；不需要就是分层错了。

**这张表由 `scripts/architecture.test.mjs` 守着**：出现未登记的白名单外依赖会直接失败；已知违规写进 `KNOWN_DEBT`，只许减少不许新增。

### 债已还清

上一版唯一的违规是 `cli/commands/{setup,doctor}.mjs` 反向 import `host/router/*`（6 处）。根因是 **Router 这个应用能力的实现住在接口层**。

已按 [cli 分层重构清单](plans/cli-layer-split.md) 处理完 P0 + P1：

| 变化 | 现在 |
|---|---|
| Router 实现（argv / script / install / credentials / probe / manager / paths …） | `cli/lib/router-*.mjs`（应用层，10 个模块） |
| host 侧 | 只剩 `host/router-session.mjs`：启动时 `adopt()` 扫 pid 接管已运行的 Router |
| `cli → host` | **0 处** |
| 守卫测试 | 从"白名单 + 债"变成纯白名单，另加两条结构规则：`cli/lib` 不许引 `cli/commands`、`cli/commands` 不许引 `host` |

## 6. 扩展一个 Agent

新增 Agent **不需要改 core / notify / 手机端**：

1. `adapters/profiles/<agent>.json`：声明能力（以 `_template.json` 为底）；
2. `adapters/<agent>.mjs`：把原始状态映射成规范事件；
3. fixtures + 契约测试；
4. `npm run docs:capabilities` 重新生成能力表。

细节见 [adapters/README.md](../adapters/README.md)。

## 7. 运行时形态

四个运行体，**解耦的边界在于"谁能不需要谁"**：

| 运行体 | 生命周期 | 依赖谁 | 没有它会怎样 |
|---|---|---|---|
| **CLI**（`mo`） | 一次性进程，命令结束即退 | 只需要磁盘（`~/.mo-agent/`） | 什么都没有 |
| **host**（`mo-agent-host`） | 常驻，直到 stop / 桌面 App 退出 | CLI（复用工作台逻辑）+ adapters | 观测、远程批准、手机/钉钉/语音消失；CLI 仍可用 |
| **desktop**（`Mo Agent.app`） | 常驻（菜单栏） | 拉起 host 子进程 | 没有菜单栏与托盘，host 仍可单独跑 |
| **客户端**（web / Android / 钉钉 / 耳机） | 会话级 | host 的 HTTP + 令牌 | 只能在终端里用 |

```
Mo Agent.app ──拉起──▶ host（常驻，无窗口）◀──HTTP+令牌── 手机 / 浏览器 / 钉钉
                          │
                          └── 调度 adapters（只读）· 注入 hooks · 推送

mo（CLI）── 独立工作：项目 · 卡 · 批准 · 派单 · 账本 · 指挥台
```

单实例由 `~/.mo-agent/desktop.lock` 保证。用户数据在 `~/.mo-agent/`，程序产物在 `~/Library/Application Support/mo-agent/`（桌面运行时）与 `~/.mo-agent/runtime/`（`mo daemon install` 装的 host 运行时）。

## 8. 构建与验证

```bash
npm test                      # core / cli / host / adapters / approvals 单测
npm run check                 # 语法检查 + 能力表时效 + 版本一致
npm run docs:capabilities     # 重新生成 docs/reference/capabilities.md
bash scripts/build-cli.sh     # 打 CLI 单文件二进制（不含 host）
bash scripts/build-desktop.sh # 打桌面端 + host 运行时（runtime.tar.gz）
```

**CLI 不含 host 是刻意的**：单文件二进制塞不进 host 的外部资产（`app/web`、`adapters/profiles`、`integrations/pi`）。只装 CLI 的用户用 `mo daemon install` 补齐 host 运行时。

## 9. 新增代码该放哪

| 你要加的东西 | 放哪 | 判定 |
|---|---|---|
| 纯策略 / 状态机 / 打分 / 命名规则 | `core/` | 不碰 IO，能被单测直接跑 |
| 一条新命令、一个工作台动作 | `cli/` | 文件即状态，不需要常驻 |
| 新的 HTTP 接口 / 推送通道 / 子进程 / 长连接 | `host/` | 需要"一直有人在那儿听" |
| 解析某家 Agent 的日志 | `adapters/` | 只读外部数据 |
| 被 Agent 回调的入口 | `approvals/` | 由外部进程触发 |
| 界面 | `app/web/` | 只能走 HTTP/SSE |
| 菜单栏、托盘、单实例 | `desktop/` | 只做进程与壳 |
| Agent 配置模板 | `hooks/` | 只是 JSON 模板 |
| 打包/安装/发版 | `scripts/`、`installer/` | — |

### workbench（P0 已实现，P1+ 规划中）

设计见 [spec/workbench-flow.md](spec/workbench-flow.md)，使用见 [cli/README.md](../cli/README.md)。

| 模块 | 位置 | 状态 |
|---|---|---|
| 状态机、卡、回执、账本事件 | `core/tasks/` | ✅ P0 |
| 项目认领、注册表 | `cli/lib/project.mjs` | ✅ P0（P1 迁到 `core/projects.mjs` + host） |
| 派单执行、回执裁决 | `cli/lib/{dispatch,runner,ingest}.mjs` | ✅ P0 |
| CLI | `cli/mo.mjs` | ✅ P0 |
| 账本落盘、检索 | `cli/lib/store.mjs`、`core/memory.mjs` | 落盘 ✅ / 检索 P3 |
| MCP 端点、守护进程派单 | `host/mcp-http.mjs`、`host/runner/` | P1 |
| 模板与 schema 文件 | `templates/`、`schemas/` | 暂缓（CLI 内联生成） |

**必须遵守同一条边界**：`core/tasks/*` 不 import `host/*`，也不 import `cli/*`。
P0 把 IO 全部放在 `cli/`，P1 起由 `host/` 复用同一套 `core/`。
