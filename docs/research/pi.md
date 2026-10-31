# 预研：Pi 的可适配性

日期：2026-10-25
研究版本：Pi 1.4.0（npm 最新）／本机 1.3.0（`~/.local/bin/pi`）
文档：<https://pi.dev/docs/latest>

## 0. 结论

**Pi 是「可编程型」Agent，不是「hook 型」Agent。**

它没有 Claude Code 那样的外部 hook 配置，也没有原生逐工具授权弹窗；但它把扩展、会话、事件、控制都做成了进程内 API，并且开放了 JSONL 会话、RPC、SDK 和 package 分发。所以：

| 能力 | 结论 | 机制 | 评级 |
|---|---|---|---|
| 观测 | 容易 | 会话 JSONL + 扩展事件 | ★★★★★ |
| 完成判定 | 明确 | `agent_settled` 事件（扩展/RPC/JSON/SDK）；transcript 可推断 | ★★★★★ |
| 等待/注意 | 需扩展 | `tool_call` / `ui_prompt_start` | ★★★★☆ |
| 审批 | **要自造闸门** | 扩展 `tool_call` 拦截；Pi 本身不弹授权框 | ★★★☆☆ |
| 控制 | 分两条路 | 用户终端会话走桥接扩展；托管会话走 RPC/SDK | ★★★★☆ |
| 分发 | 很顺 | `pi install` + Pi package | ★★★★★ |
| 稳定性 | 有版本耦合 | 扩展 API 随 Pi 版本演进 | ★★★☆☆ |

一句话建议：

> **观测走 transcript，审批和控制走一个用户级 Pi 扩展，分发做成 Pi package；RPC/SDK 只用于 Mo 自己托管的 Pi 会话；不要指望 ACP。**

关键认知差别：

- Claude Code 是「厂商先弹授权框，hook 代替用户回答」。
- Pi 是「厂商根本不弹框，默认全放行；我们的扩展决定要不要拦」。

所以给 Pi 做远程批准，不是接管一个既有弹窗，而是**给 Pi 装一套它本来没有的刹车**。这比 Claude Code 更自由，也更需要我们自己承担失败策略。

## 1. Pi 的架构适配面

### 1.1 会话：开放、可解析

默认位置：

```text
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
```

- 每行一个 JSON，第一行是 `{"type":"session","version":3,...}` 头，带 `cwd`、`id`。
- 之后是树形条目：`id` / `parentId`，支持同一文件内分支（`/tree`、`/fork`）。
- 常见 `type`：`message`、`model_change`、`thinking_level_change`、`compaction`、`branch_summary`、`custom`、`custom_message`、`label`、`session_info`。
- 助手消息带 `stopReason`：`stop` / `toolUse` / `length` / `error` / `aborted` / `deferred`。
- 最后一条条目就是当前活动叶子；按 `parentId` 回溯可还原当前分支。

本机实测（Pi 1.3.0，真实会话）：

```text
01a16bf4  root   session
3f3b941f  root   model_change
b0b38ec1  3f3b941f thinking_level_change
6df7763c  b0b38ec1 message system
d3f9d44e  6df7763c message user
40a6d3a1  d3f9d44e message assistant toolUse
e8beb64f  40a6d3a1 message toolResult
122b3992  e8beb64f message assistant toolUse
b8a3ce0f  122b3992 message toolResult
9d7aa806  b8a3ce0f message assistant stop
```

这套格式足够做 Claude Code 同构的 transcript 适配：

- 新 `user` 消息 → 新的一轮；
- 最后一条 `assistant` 的 `stopReason` 为 `stop` → 本轮结束；
- `error` / `aborted` → 失败 / 取消；
- `toolUse` → 还在跑。

但 transcript **看不到「正在等授权」**，也看不到 `agent_settled`。原因是这两类信号都不在会话条目里：

- `agent_settled` 是**运行时事件**，只在扩展事件、RPC、JSON 事件流、SDK 订阅里出现，不落 JSONL。
- Pi 本身**没有原生授权**，所以不存在「等授权」这个持久状态；如果我们的扩展加了闸门，等待中的状态也只有闸门自己知道。

因此准确说法是：**要看这两类信号，必须读事件流（扩展 / RPC / JSON / SDK）；只读 transcript 只能推断。** 对用户在终端里跑的 TUI，外部拿不到事件流，所以才需要扩展把信号带出来。

判定依据（不是只靠本地抽样）：

- **类型定义**：Pi 1.3.0 与 1.4.0 的 `SessionEntry` 联合类型都只有 11 种：`message` / `thinking_level_change` / `model_change` / `usage` / `compaction` / `branch_summary` / `custom` / `custom_message` / `context_edit` / `label` / `session_info`。没有 settle / approval 条目。
- **官方文档**：Session File Format 的 Entry Types 与上述一致；JSON Event Stream 把 `agent_settled` 列为事件；Security 明确「does not ask for approval before every tool call」。
- **本机数据**：14 个会话、140 条条目，只有 `session`(14)、`message`(92)、`model_change`(18)、`thinking_level_change`(16)；没有任何 settle / approval 条目。
- **逃生口**：`custom` 是扩展主动写的。我们的闸门可以用 `pi.appendEntry()` 把「等待审批」写成自定义条目，让它出现在 transcript；但这不是 Pi 自动记录的，而是我们额外做的。

### 1.2 扩展：进程内 TypeScript，能力接近「宿主插件」

Pi 扩展是加载进 Pi 进程的 TypeScript/JavaScript 模块，默认工厂收到 `ExtensionAPI`。本机 `pi -e ./ext.js --help` 已验证扩展会被加载，并注册 CLI flag。

对 Mo Agent 最关键的能力：

| 需求 | Pi 扩展 API |
|---|---|
| 识别会话 | `ctx.sessionManager.getSessionId()` / `getSessionFile()` / `getCwd()` |
| 会话开始/结束 | `session_start` / `session_shutdown` |
| 一轮开始/结束 | `before_agent_start`、`agent_start`、`agent_settled`（真正空闲） |
| 拦截工具 | `tool_call`，可 `{ block: true, reason }`，也可改写 `event.input` |
| 终端确认 | `ctx.ui.confirm()` / `select` / `input` |
| 发消息 | `pi.sendUserMessage()` / `pi.sendMessage()` |
| 中断 | `ctx.abort()` |
| 空闲判断 | `ctx.isIdle()`、`ctx.hasPendingMessages()` |
| 运行模式 | `ctx.mode`（`tui` / `rpc` / `json` / `print`）、`ctx.hasUI` |
| 生命周期 | `session_shutdown` 里释放 socket/定时器 |

#### 扩展算不算 hook？

算，但要把「hook 的形状」和「hook 的传输方式」分开：

- **形状**：在生命周期点插入回调。Pi 扩展的 `session_start`、`tool_call`、`agent_settled` 都是 hook；Pi 文档自己也把模型请求、工具执行前后的处理器叫 hooks。
- **传输**：Claude Code 是「外部子进程 + stdin/stdout JSON + settings.json 配置」；Pi 是「进程内模块 + 直接函数调用 + package/目录加载」。

所以对 Mo 的能力模型，建议拆成两个维度，而不是一个：

| 维度 | 取值 |
|---|---|
| 决策能力 | 放行 / 仅拦截 / 仅通知 / 无 |
| 接入方式 | 外部 hook / 进程内扩展 / 原生 API / ACP / 日志 |

对照：

| | 外部 hook（Claude Code） | 进程内扩展（Pi） |
|---|---|---|
| 边界 | 进程 + JSON | 函数调用 + 共享进程 |
| 能力 | 事件 + 决策 | 事件 + 决策 + 工具/Provider/UI/控制 |
| 失败隔离 | 子进程退出，容易隔离 | 同进程；慢 handler 会拖流，异常可能影响 Pi |
| 信任 | 可单独审查/限制 | 与 Pi 同权限，能读凭据和会话 |
| 契约 | 厂商定义的 JSON schema | Pi 的 TypeScript API，随版本演进 |

结论：**Pi = 放行型 + 进程内扩展**；Claude Code = 放行型 + 外部 hook。把「能不能批」和「怎么接」分开，才不会把两者当成同一种适配成本。

因此，Mo 现有的「写 settings.json + hook-cli」交付方式不能直接套到 Pi：Pi 的 settings schema 没有 `hooks` 字段，CLI 也没有 hook 选项（1.3.0 实测）。Pi 侧最小可交付物是一个扩展文件或一个 Pi package；可以做到「装 hook 一样的一键安装」，但运行机制不是外部 hook。

扩展不是外部子进程，而是和 Pi 同权限、同进程。这带来两个直接后果：

1. **能做很深的集成**：不需要 Pi 提供 hook 协议，我们自己就是协议。
2. **信任成本高**：扩展能读凭据、会话、文件；装扩展等于装代码。文档也明确说扩展以 Pi 进程权限运行。

### 1.3 运行接口：四种形态

| 形态 | 命令 | 适合 Mo 的什么场景 |
|---|---|---|
| 交互 TUI | `pi` | 用户在终端自己跑，Mo 旁观/接管 |
| Print | `pi -p "..."` | 无头执行，拿最终文本 |
| JSON 事件流 | `pi --mode json "..."` | 无头执行，拿结构化过程 |
| RPC | `pi --mode rpc` | Mo 自己托管一个长生命周期 Pi，双向控制 |
| SDK | `createAgentSession()` | 嵌进 Node/Bun 进程 |

RPC 的协议面很完整：`prompt` / `steer` / `follow_up` / `abort` / `get_state` / `get_messages` / `get_entries` / `set_model` / `compact` / `bash` 等；扩展的 `ctx.ui.confirm` 会变成 `extension_ui_request`，由 RPC 客户端回答。这是「托管 Pi」最干净的审批通道。

但 RPC 没有 TUI。它只适合 Mo 启动并拥有的会话，覆盖不到用户自己在终端里跑的 Pi。

### 1.4 其他适配面

- **模型**：OpenAI/Anthropic 兼容端点、自定义 provider、virtual models、本地 llama.cpp。本机就用 `deepseek/deepseek-v4-flash`。
- **资源**：`AGENTS.md` / `CLAUDE.md`、skills、prompt templates、themes、MCP。
- **分发**：Pi package 可以把扩展、skills、prompts、themes 打成一个 npm/git 包，`pi install npm:@scope/pkg` 一条命令安装。
- **许可**：MIT。源码 fork 可用 `piConfig.name` / `configDir` 改 CLI 名和配置目录。
- **Node 要求**：SDK 需要 Node `>=22.19.0`（package.json）。本机 Node 22.23.2，满足；仓库本身声明 `>=18`，若走 SDK 嵌入选型要注意。

## 2. 五档模型下的 Pi

沿用 `docs/research/remote-approval-hooks.md` 的分档：

| 档位 | Pi 的对应 |
|---|---|
| 放行型 | ✅ 扩展 `tool_call` 可以放行、拒绝、改写输入 |
| 仅拦截型 | — |
| 仅通知型 | — |
| ACP | ⚠️ 有社区 `pi-acp`，但**明确不支持** `session/request_permission` |
| 无 | — |

但 Pi 的「放行型」和 Claude Code 的含义不同：

| 维度 | Claude Code | Pi |
|---|---|---|
| 原生授权框 | 有 | **没有**（默认不逐工具确认） |
| 外部 hook | `settings.json` 配命令 | **没有**；只有进程内扩展 |
| 审批语义 | hook 代替用户回答厂商弹窗 | 扩展自己决定拦不拦 |
| 拒绝后的表现 | 厂商 UI 显示拒绝 | 工具返回错误结果，模型可能重试 |
| 控制会话 | 一般靠 ACP/SDK | 扩展/RPC/SDK 都可以 |
| 安装成本 | 写 JSON + 一个命令 | 装一个扩展文件/包 |
| 信任成本 | 子进程 | 进程内，权限更大 |

**所以 Pi 的审批能力不能简单标成「比 Claude Code 强」**：它更自由，但没有「厂商弹窗」这个兜底。我们必须自己定义：没人决策时怎么办。

### 2.0.1 澄清：Pi 没有的是「工具审批」，不是「所有确认」

| 层 | Pi 的情况 |
|---|---|
| 工具执行审批 | **没有**。没有 `PermissionRequest` 事件、没有 permission mode、没有 allow/deny 规则引擎，默认全放行 |
| 通用确认 UI | **有**。扩展可调 `ctx.ui.confirm` / `select` / `input` / `editor`；RPC 模式下可转发给客户端 |
| 其他确认 | **有**。项目信任、OAuth 登录、删除会话等 |
| 隔离 | **无内置沙箱**。官方建议用容器 / VM / 独立用户账号 |

所以准确说法是：Pi 把「工具审批」交给扩展或外部系统，把「安全」交给隔离。它不是一个「没有确认 UI」的 Agent，而是一个「没有内置工具权限系统」的 Agent。

这也是 Pi 的设计选择，不是遗漏。官方安全文档的原话是：

> Pi can read, change, and execute files with the permissions of the account that started it, and it does not ask for approval before every tool call.

文档给的安全建议是容器、VM、独立用户、限制凭据和网络，而不是「每次执行前点一下」。在这个哲学下，`--tools` 这类启动时的能力裁剪，比运行时的逐次审批更符合 Pi 的模型。

对 Mo 的含义：我们不是「接管 Pi 已有的审批」，而是「给 Pi 补一层它本来没有的审批」。这既解释了为什么扩展是唯一入口，也解释了为什么必须自己定义失败/超时策略。

### 2.1 DEFER 语义冲突（最重要的设计点）

Mo 现有 broker 的核心原则（ADR-0001）是：

> 手机不在线 / 超时 → 返回 `defer` → hook 退出 → **用户在终端照常看到厂商授权框**。

Pi 没有厂商授权框，`defer` 无处可去。桥接扩展必须自己补一个「本地兜底」，建议：

| 模式 | `defer` 的处理 |
|---|---|
| TUI | 调 `ctx.ui.confirm()`，在终端弹确认，等价于「交回本地终端」 |
| RPC（Mo 托管） | 由 RPC 客户端回答；Mo 的手机审批就是客户端 |
| JSON / Print | 没有 UI；默认拒绝（fail-closed），或按配置直接放行（不推荐） |

这样既守住「没有你的决定，不替你放行」，又不会让 Pi 卡死。

## 3. 三条接入路线

### 路线 A：transcript 观测 + 桥接扩展（推荐）

**形态**：和 Claude Code 一样，transcript 负责「看见」，扩展负责「卡点」和「控制」。

```text
Pi TUI (用户终端)
 ├─ 会话 JSONL ──→ PiAdapter（transcript 轮询）──→ session.upsert / run.*
 └─ Mo 扩展 ──→ 本地 HTTP/WS ──→ Mo host
                 ├─ tool_call → /local/approval → 手机决定
                 ├─ 下行 prompt/abort
                 └─ session_start / agent_settled 事件（可选增强）
```

**优点**

- 不改 Pi 源码，不做 fork。
- 用户照常在自己终端跑 Pi。
- 观测不依赖扩展；扩展没装也能看到「在跑/跑完」。
- 审批、控制是扩展的强项，延迟低。
- 与现有 adapter/hook 架构最接近，改动面小。

**缺点**

- 要用户装一次扩展（可以做成 `pi install` 一条命令）。
- 扩展是进程内代码，安全审查要求高。
- Pi 升级可能导致扩展 API 漂移。

**审批流程**

```text
tool_call 事件
  → 扩展 POST /local/approval（payload 复用 hook-cli 的字段）
      { agent:"pi", sessionId, toolName, toolInput, cwd, kind:"approval" }
  → broker 挂起，手机决定
      allow_once / allow_always → 扩展返回 undefined（放行）
      reject_once / reject_always → { block:true, reason:"用户在手机上拒绝" }
      defer → TUI: ctx.ui.confirm；非 TUI: 拒绝
```

**控制流程**

- 手机发指令：Mo host 通过本地 WS/长轮询把文本下发到扩展 → `pi.sendUserMessage(text, { deliverAs })`。
  - 空闲：直接起一轮。
  - 正在跑：必须选 `steer`（当前轮工具执行完后插入）或 `followUp`（本轮全部结束后插入）。这和 DSH 的 prompt 语义要对齐。
- 手机中断：`ctx.abort()`。

**观测兜底**

- 扩展未安装 / 版本不兼容时，transcript adapter 仍能给出 `session.upsert` 和粗粒度 `run.completed`。
- 扩展安装后，可以用 `agent_settled` 把完成判定从「推断」升级为「明确」。

**分发**

把扩展 + 可选 skills 打成一个 Pi package：

```text
mo-agent-pi/
├── package.json        # keywords: ["pi-package"], pi.extensions
├── extensions/
│   └── mo-agent.ts
└── README.md
```

安装：

```bash
pi install npm:@mo-agent/pi-bridge
```

这比让用户手写 `~/.pi/agent/extensions/` 文件更像产品。

### 路线 B：只做 transcript 观测（最小可用）

- 位置：`~/.pi/agent/sessions/--*/*.jsonl`。
- 能力：会话发现、标题（第一条 user）、在跑/完成/失败、最近一问一答。
- 不能：审批、控制、精确等待状态。
- 适用：先让 Pi 出现在监控屏，审批后续再加。

风险：Pi 可能自动重试、压缩、继续 follow-up，`agent_end` 不等于最终完成；transcript 里没有 `agent_settled`（它只存在于事件流），只能按「最后一条 assistant 的 stopReason」推断，边界不如读事件流明确。

### 路线 C：RPC / SDK 托管（补充，不替代）

- **RPC**：Mo 启动 `pi --mode rpc`，拿完整事件流、`extension_ui_request` 审批、`abort` 控制。没有 TUI，用户看不到终端界面。
- **SDK**：在 Mo 的 Node/Bun 进程里直接 `createAgentSession()`，控制力最强，但等于 Mo 自己成了 Pi 宿主，不再是「旁观者」。
- **适用**：Mo 的「托管跑一个任务」场景（类似现在的 `pi-headless`），不是「用户在终端自己跑」的场景。

### 路线 D：ACP（不推荐作为审批路线）

社区有 `pi-acp`（`@victor-software-house/pi-acp`），通过 SDK 把 Pi 包成 ACP agent，支持会话、模型切换、工具调用、终端委派等；但 README 的 Limitations 明确写：

> `session/request_permission` — pi does not request permission from ACP clients before tool execution.

也就是说，走 ACP 只能观测/控制，**不能审批**。除非我们 fork `pi-acp` 并在里面加载一个 gate 扩展，但那已经回到路线 A 的成本。

## 4. 落地设计草案

### 4.1 profile 草案

```json
{
  "id": "pi",
  "label": "Pi",
  "enabled": true,
  "module": "./pi.mjs",
  "export": "PiAdapter",
  "process": {
    "match": [
      "(^|/)pi(\\s|$)",
      "pi-coding-agent/dist/(bundle/)?cli\\.js"
    ]
  },
  "session": {
    "kind": "jsonl-transcript",
    "root": "~/.pi/agent/sessions",
    "pattern": "--*/*.jsonl"
  },
  "capabilities": {
    "observe": ["process", "transcript", "extension"],
    "runEnd": "explicit",
    "attention": "extension",
    "approval": "allow",
    "control": ["prompt", "cancel"]
  },
  "hooks": { "kind": "pi-extension", "package": "npm:@mo-agent/pi-bridge" },
  "approval": {
    "capability": "allow",
    "mechanism": "tool_call 扩展闸门",
    "note": "Pi 无原生授权框；defer 时回落到 ctx.ui.confirm（TUI）或拒绝"
  }
}
```

`observe` / `attention` 里的 `extension` 是新增语义；现有枚举是 `process / transcript / native-api / acp / log` 与 `hook / native / derived / none`。实现时二选一：新增枚举，或先用 `native-api`（但 registry 会因缺少 `dsh` 跳过，需调整判断）。

### 4.2 事件映射

| Pi 信号 | 规范事件 | 备注 |
|---|---|---|
| `session_start` | `session.upsert` | `sessionId = "pi:" + getSessionId()`，标题取第一条 user |
| 第一条 user message | `session.upsert` + `run.started` | transcript 也能做 |
| `agent_settled` | `run.completed` / `run.canceled` | `aborted` 决定 completed/canceled |
| 最后一条 assistant `stopReason=error` | `run.failed` | transcript 兜底 |
| `tool_call` 被拦 | `approval.pending`（host 生成） | 扩展只 POST，不直接发事件 |
| 手机决定 | `approval.resolved`（host 生成） | broker 统一处理 |
| `session_shutdown` | 进程消失 / 会话离线 | 不要伪造 `session.removed`，除非文件真删 |

`runId` 建议用 `makeRunId(sessionId, turnIndex)` 或活动叶子 entry id；Pi 有分支，不要用「第几条消息」当 key。

### 4.3 审批闸门策略

不要拦所有工具，否则 Pi 并行工具调用会一次弹很多卡。建议默认：

- 必拦：`bash`、`edit`、`write`；
- 可选：`read` 工作目录外、MCP 写操作、带 `destructiveHint` / `openWorldHint` 的工具；
- 不拦：`grep`、`find`、`ls`、工作目录内 `read`。

Pi 的 `tool_call` 事件可以拿到 `toolName` 和 `input`；`pi.getAllTools()` 还能拿 MCP annotations。可以复用文档里的 permission-gate 思路。

请求 payload 里的 `sessionId` 传原始 id 即可：现有 `/local/approval` 会先按原值查，再按 `agent:` 前缀查；传 `agent:"pi"` + 原始 id 就能命中 `pi:<id>` 会话。

并发注意：同一条 assistant 消息里的工具可能并行执行，`tool_call` 会接连触发。手机端要能排队，broker 要支持多个 pending；「总是允许」规则按 `agent + toolName` 记忆，能显著减少打扰。

### 4.4 控制协议

前提：Pi 没有外部控制 socket，print/json 模式是一次性的；能下行的只有三种通道：

1. Mo 启动 Pi 时用 `-e` 注入控制扩展，**保留 TUI**；
2. `pi --mode rpc`，**没有 TUI**，但协议最全；
3. 全局控制扩展，覆盖**用户自己开的 Pi TUI**。

审批可以不做，控制仍然成立：控制扩展不碰 `tool_call`，不拦工具，只负责连 host、收发指令、调 `sendUserMessage` / `abort`。

#### 路线 1：`-e` + TUI（推荐给交互任务）

```bash
pi -e ~/.mo-agent/pi-control.js
```

扩展职责：

- `session_start`：连 Mo host，上报 `{ sessionId, sessionFile, cwd, pid }`；
- 下行 `prompt`：空闲时 `pi.sendUserMessage(text)`；运行中必须带 `deliverAs`（`steer` 或 `followUp`）；
- 下行 `abort`：`ctx.abort()`；
- 上行 `ack` / `state`（`isIdle`、`hasPendingMessages`）；
- `session_shutdown`：幂等断开。

语义：

| 场景 | 行为 |
|---|---|
| 空闲 + 发指令 | 起新一轮 |
| 运行中 + 发指令 | 默认 `followUp`（等本轮完）；用户选「插入」则 `steer`（当前轮工具执行完后插入） |
| 中断 | `ctx.abort()` 停当前 run |
| 暂停/恢复 | Pi 不支持，只能中断后重新发 |

已知边界：

- 扩展 API 没有 `clear_queue`。`abort` 之后，已排队的 steering/followUp 可能继续；RPC 有 `clear_queue`，扩展没有。要「彻底停」，优先用 RPC。
- `ctx` 是会话绑定的。session 切换后旧 ctx 失效，需要在 `session_start` 和每次事件里刷新。
- 已验证（Pi 1.3.0）：`abort` 会终止正在运行的 bash 工具；`sleep 30` 在约 1.8 秒时收到 `This operation was aborted`，随后 `agent_settled(aborted=true)`。

#### 路线 2：RPC（推荐给无头/批量）

```bash
pi --mode rpc --session-id mo-<taskId>
```

命令：

```json
{"id":"1","type":"prompt","message":"继续，但先跑测试","streamingBehavior":"followUp"}
{"id":"2","type":"steer","message":"停一下，改这个方向"}
{"id":"3","type":"clear_queue"}
{"id":"4","type":"abort"}
{"id":"5","type":"get_state"}
```

- `prompt` 的 response 只代表「已接受/已排队」，完成要看 `agent_settled`；
- `abort` 会等会话空闲再返回；要硬停，先 `clear_queue` 再 `abort`；
- `get_state` 拿 `isStreaming`、`sessionId`、`sessionFile`；
- 事件流里还有 `tool_execution_*`、`message_update`，可用于手机端实时进度；
- 没有 TUI，用户看不到终端；适合 `pi-headless` / CI / 长任务。

#### 路线 3：全局控制扩展（用户自开 Pi）

用户自己开的 Pi 没有 `-e` 注入点，也没有外部 socket；要控制它，**只能装一个全局扩展**。这是「用户自开 Pi」的唯一可靠方案，PATH wrapper / tmux send-keys 都不稳。

安装位置（二选一）：

```text
~/.pi/agent/extensions/mo-control.js        # 自动发现
或 settings.json: "extensions": ["~/.mo-agent/pi-control.js"]
```

扩展只做控制，**不注册 `tool_call`**，所以不会拦工具、不会产生审批洪水。

##### 连接方式：扩展主动连 host

host 现在没有 WebSocket 服务端，因此推荐 **HTTP 长轮询**，复用 `/local` 的 token 鉴权：

```text
POST /local/pi/session      { sessionId, sessionFile, cwd, pid }
GET  /local/pi/commands?sessionId=...&wait=25000
POST /local/pi/ack          { sessionId, id, ok, error? }
POST /local/pi/event        { sessionId, event, ... }
```

- 扩展在 `session_start` 读 `~/.mo-agent/session.json`，注册会话后进入长轮询；
- host 挂起请求最多 25 秒，有指令立即返回，没有就空返回，扩展再发起下一次；
- 断线/超时 → 指数退避重连；**host 不在时只是控制不可用，Pi 照常运行**；
- 所有请求带 `x-mo-agent-local` token，只连 localhost。

##### 指令处理

| 下行 | 扩展行为 |
|---|---|
| `prompt` + idle | `pi.sendUserMessage(text)` |
| `prompt` + running | `deliverAs: "followUp"`（默认）或 `"steer"` |
| `abort` | `ctx.abort()` |

- 控制回调里不要把 fetch 挂在 Pi 的事件循环上：ack 用 fire-and-forget + catch；
- `ctx` 在 `session_start` 和每次事件里刷新，session 切换后旧 ctx 失效；
- 已验证（Pi 1.3.0）：在 `session_start` 的定时器里调用 `pi.sendUserMessage()`，能起完整一轮（`agent_start` → `message_start` user/assistant → `agent_settled`）；调用 `ctx.abort()` 能中断正在执行的 bash 工具，并触发 `agent_settled(aborted=true)`。

##### 加载安全（全局扩展的代价）

全局扩展加载失败会让 `pi` exit 1，所以：

1. `mo-control.js` 只做一件事：`try { await import("./mo-control-impl.js") } catch {}`，绝不抛错；
2. 实现文件无第三方依赖，语法错误最多让控制失效，不会让 Pi 起不来；
3. 安装时原子写入 + 备份；
4. 健康检查用 `pi --mode rpc --no-session -e <ext>` + `get_state`，不要用 `--help`；
5. 提供 `MO_PI_DISABLE=1`、`pi -ne` 和卸载入口。

##### 能力边界

- 没有 `clear_queue`：`abort` 后已排队的 steering/followUp 可能继续；
- 没有暂停/恢复；
- 用户在终端里同时输入时，手机指令和本地输入会排队，顺序由 Pi 决定；
- 只能控制装了扩展的 Pi；没装就是纯观测。

#### 传输与生命周期（路线 1/2 通用）

```text
Mo host ──下行──→ 扩展/子进程
  { type:"prompt", text, deliverAs?: "steer"|"followUp" }
  { type:"abort" }
  { type:"clear_queue" }   // 仅 RPC
扩展 ──上行──→ Mo host
  { type:"ready", sessionId, sessionFile, cwd, pid }
  { type:"state", isIdle, hasPendingMessages }
  { type:"ack", requestId, ok, error? }
```

传输建议：

1. 扩展启动时读 `~/.mo-agent/session.json`（和 hook-cli 一样）；
2. 优先 WebSocket 连 host（host 已有 `ws`），其次长轮询；
3. 所有请求带 `x-mo-agent-local` token；
4. 只连 localhost，不监听外部地址；
5. 断线不影响 Pi 本身：控制禁用，TUI 照常。

### 4.5 与现有 mo executor 的关系

仓库里已经有 `pi` 和 `pi-headless` 两个执行模板：

```js
pi: { command: "pi", session: true }
"pi-headless": { command: 'pi -p "$(cat)"' }
```

可以顺手做三件事：

1. **固定会话 ID**：`pi --session-id mo-$MO_TASK_ID -p "$(cat)"`，之后 Mo 一定能找到对应 JSONL。
2. **无头用 JSON 事件流**：`pi --mode json -p "$(cat)"`，把事件落到 `.mo-agent/pi-events.jsonl`，监控和回执都能用。
3. **限制工具而不是依赖审批**：无头运行没有手机在旁边，`pi --tools read,grep,find,ls` 或 `--no-builtin-tools` 比「等审批」可靠。

无头模式不需要桥接扩展的审批；如果扩展也在无头模式加载，应默认不拦（或只记录），否则会卡死自动化。这与「TUI 才拦」的策略一致。

### 4.6 分发与安装

- 首选：Pi package，`pi install npm:@mo-agent/pi-bridge`。
- 备选：一键写入 `~/.pi/agent/extensions/mo-agent.js`，改动前备份（现有「一键配置 Agent」的做法）。
- 也可以让用户用 `pi -e ./mo-agent.ts` 试用，不落盘。

用户级扩展对所有项目生效；项目级扩展要过 project trust。桥接扩展应装用户级，但只监听本机、只处理 Mo 的 token，不读项目内容。

### 4.7 Mo 不在时的降级策略

这是 Pi 接入特有的风险：Claude Code 没装 hook 还有原生授权框，Pi 没有；扩展装错反而可能让 Pi 不可用。

本机实测的失败模式（Pi 1.3.0）：

| 失败点 | 行为 |
|---|---|
| 扩展文件加载或 factory 抛错 | `pi` 直接 exit 1，连 TUI 都进不去 |
| `session_start` handler 抛错 | 输出 `extension_error` 事件，Pi 继续运行 |
| `tool_call` handler 抛错 | 官方文档：fail-safe 阻断该工具 |
| 扩展未安装 / 未加载 | Pi 默认全放行，正常工作 |

所以扩展必须把「Mo 不在」当成正常状态，而不是错误状态：

| 状态 | 判定 | 行为 |
|---|---|---|
| 未配置 | 无 `~/.mo-agent/session.json`、无 token、`MO_PI_DISABLE=1` | 完全不介入，零影响 |
| 未连接 | 连接被拒 / 超时 / 401 | pass-through（Pi 默认行为），可选一次性提示 |
| 已连接 | 正常 | 按策略拦截 |
| 连接丢失 | 本次会话曾连上，后来断 | TUI 回落 `ctx.ui.confirm`；非 TUI pass-through 或拒绝；后台重连 |
| 内部异常 | try/catch 捕获 | 关闭闸门，记一次错误，Pi 继续 |

实现约束：

1. factory 只做注册，不做网络/文件 I/O，整体包 try/catch，绝不抛错。
2. 入口文件保持极小、无第三方依赖；实现放 `bridge-impl.js`，用 `await import()` 包在 try/catch 里加载。实现文件语法错误也只会让闸门失效，不会让 Pi 起不来。
3. `session_start` 连接 Mo 用 1–2 秒超时；失败即 `absent`，不要重试到阻塞启动。
4. `tool_call` 永远返回结果，不 throw；所有 fetch 加 `AbortSignal.timeout`；网络错误 → 回落终端确认或 pass-through。
5. 默认只拦 TUI；JSON/Print/headless 直接 pass-through，避免卡死自动化。
6. 安装器做真实启动健康检查：`pi --mode rpc --no-session -e <ext>` + `get_state`，失败自动回滚。**不要用 `pi --help` 做检查**——实测扩展加载失败时 `--help` 仍 exit 0。
7. 提供 `pi -ne`、`MO_PI_DISABLE=1` 和卸载命令作为逃生口。

另外，Pi package 安装失败时 Pi 会警告并跳过，属于非致命；但**已安装包的扩展代码在加载时抛错，仍是致命的**。所以「用 package 分发」降低的是安装失败风险，不是代码缺陷风险。

## 5. 风险与边界

1. **Pi 默认没有审批，也没有沙箱**。工具以进程权限运行。Mo 的闸门是「产品层」而非「安全边界」；真正的隔离要靠容器/独立用户。
2. **扩展是进程内代码**。装扩展 = 给 Pi 进程加一段可读凭据、会话、文件的代码。分发时要可审查、可签名、可卸载。
3. **版本耦合**。扩展 API 随 Pi 版本变化；本机 1.3.0，npm 已 1.4.0。需要 feature-detect + 版本矩阵测试；`pi update` 可能悄悄升级。
4. **DEFER 语义**。没有原生弹窗，超时/离线必须有本地兜底；否则要么卡死，要么变成 fail-open。
5. **审批洪水**。Pi 并行工具调用多，默认拦太多会烦。要工具分级 + `allow_always` + 批量/排队。
6. **分支与重试**。同一 session 文件可能有多个分支；`agent_end` 后还可能重试/继续。完成判定应使用事件流里的 `agent_settled`，transcript 只能近似。
7. **会话含敏感信息**。命令输出、文件内容、密钥都可能进 JSONL；读取和上传要有边界。
8. **无头模式**。没有 UI，审批无法回落；应默认不拦，靠工具白名单和工作目录约束。

## 6. 建议

### 先决定目标，再决定做不做

Pi 没有原生审批点，所以「Pi 审批适配」不是补齐差距，而是**新增一个 Pi 本来没有的能力**。这会改变 Pi 的默认行为，成本也不只是写代码。建议按目标拆：

| 目标 | 建议 | 成本 | 风险 |
|---|---|---|---|
| 看见 Pi（监控屏） | **做**。transcript adapter | 1～2 天 | 低，不碰 Pi |
| Mo 调度的 Pi 加闸门 | **做**。`-e` 注入 + RPC | 2～3 天 | 低，不装全局 |
| 用户自开 TUI 的远程批准 | **缓做 / 可选** | 3～5 天 | 高：全局扩展、启动风险、改默认行为 |
| 手机给 Pi 发指令 | **缓做** | 2～3 天 | 中：需要常驻桥接 |
| 无头 Pi 审批 | **不做** | — | 应靠 `--tools` 限制 |

判断依据：

- 如果 Mo 的定位是「看见所有 Agent」，Pi 的观测适配便宜且值得做。
- 如果 Mo 的定位是「远程批准」，Pi 是弱目标：用户选 Pi 可能恰恰因为它不打断；补闸门是逆着产品默认走。
- 如果 Pi 用户占比低，停在观测；Pi 继续作为 `mo task dispatch` 的 executor 即可。
- 只有明确要覆盖「用户自开的 Pi TUI」时，才值得做全局扩展；否则用 `-e` 注入托管会话，风险小得多。

### 如果决定做，优先级

- **P0（1～2 天）**：`PiAdapter` transcript 观测 + fixtures。
- **P1（2～3 天）**：Mo 托管 Pi 的 `-e` 闸门 + RPC 控制（不装全局）。
- **P2（3～5 天）**：用户自开 TUI 的全局扩展（opt-in），含健康检查/回滚。
- **P2（2～3 天）**：手机发指令（`sendUserMessage` + steer/followUp）。
- **不做**：无头 Pi 审批；用 `--tools` / 容器约束。

### 验证清单

1. Pi 1.3.0 / 1.4.0 都能加载扩展，`session_start` 拿到 sessionId 和文件路径。
2. `tool_call` 返回 `{block:true}` 时工具确实不执行，模型收到错误。
3. 手机 allow 后工具正常执行；`allow_always` 生效。
4. 手机离线/超时 → TUI 弹 `ctx.ui.confirm`；非 TUI 拒绝。
5. 并行工具调用时多个审批不串号。
6. 手机 abort → `agent_settled(aborted=true)`。
7. 空闲时 `sendUserMessage` 起新轮；忙时 steer/followUp 行为符合预期。
8. transcript 分支场景下，按最后叶子取到正确的一轮。
9. 扩展卸载/报错时，transcript 观测不受影响。
10. `pi-headless` 不会被闸门卡住。

## 附录：Claude Code hooks 对照

（2026-10-25 查 `code.claude.com/docs/en/hooks`，仅摘与 Mo 审批相关的部分）

### A.1 结构：event → matcher → handler

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash|Edit",
        "hooks": [
          { "type": "command", "command": "node hook-cli.mjs", "timeout": 120 }
        ]
      }
    ]
  }
}
```

- **event**：生命周期点，如 `PreToolUse`、`PermissionRequest`、`Notification`、`Stop`。
- **matcher**：按工具名/会话来源/通知类型过滤；支持精确串、`|` 列表、正则。
- **handler**：5 种类型 —— `command`（子进程）、`http`（POST）、`mcp_tool`、`prompt`（模型判断）、`agent`（子代理判断）。
- 同一事件匹配到的 handler **并行执行**；默认 `timeout` 600 秒（command/http/mcp_tool）。
- `if` 可再按权限规则收窄，例如 `"Bash(git *)"`。

对 Mo 的直接含义：Claude 侧的「审批」不是自己造事件，而是挂在 `PermissionRequest` 上——这个事件**只在 Claude 即将弹授权框时触发**，所以天然不会对每次工具调用都打扰人。

### A.2 数据协议

公共输入字段（stdin / HTTP body）：

```text
session_id, prompt_id, transcript_path, cwd, permission_mode,
hook_event_name, agent_id, agent_type
```

`PermissionRequest` 额外带 `tool_name`、`tool_input`、`permission_suggestions`。

输出有两条路：

1. **退出码**：0 成功；2 阻断（但 `PermissionRequest` 不认 2）；其它 = 非阻断错误。
2. **stdout JSON**（exit 0）：通用字段 `continue` / `systemMessage` / `terminalSequence`，事件专属字段放 `hookSpecificOutput`。

`PermissionRequest` 的决策：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": { "command": "npm run lint" },
      "updatedPermissions": []
    }
  }
}
```

- `behavior`：`allow` / `deny`；`deny` 可带 `message`、`interrupt`。
- `allow` 可改 `updatedInput`、可写权限规则 `updatedPermissions`（session/local/project/user 四种 destination）。
- `Allow always` 在 Claude 侧可以落成真实权限规则；Mo 目前只用 broker 内存规则，这是可补的一环。

### A.3 失败语义：默认回到人，而不是放行

| 情况 | Claude 的行为 |
|---|---|
| hook 未安装 / 返回空 | 走原生授权框 |
| hook 超时 | 丢弃输出，走原生授权框 |
| hook 崩溃 / 非 0/2 退出 | 非阻断错误，走原生授权框 |
| 显式 `onFailure: "block"` | 失败时阻断（PermissionRequest 则拒绝） |
| 非交互模式、无人可问、hook 无决策 | **拒绝**（fail-closed） |

这是 Claude 和 Pi 最本质的差别：**Claude 的 hook 是「加在原生授权框前面的一层」，失败就退回原生框；Pi 没有原生框，扩展失败要么放行、要么阻断。**

### A.4 与 Pi 的逐项对照

| 维度 | Claude Code | Pi |
|---|---|---|
| 挂载方式 | settings JSON 声明 + 子进程/HTTP | 装扩展模块，代码里 `pi.on()` |
| 触发点 | `PermissionRequest`（即将弹框时） | `tool_call`（即将执行时） |
| 过滤 | matcher + `if` 权限规则 | 自己在 handler 里判断 |
| 决策协议 | exit code + stdout JSON | 函数返回值 `{block, reason}` |
| 改输入 | `updatedInput` | 直接改 `event.input` |
| 持久规则 | `updatedPermissions` | 无原生规则；自己存/appendEntry |
| 超时 | 框架统一 `timeout` | 自己用 `AbortSignal.timeout` |
| 失败默认 | 回落到人 | 放行（不抛）或阻断（抛） |
| 加载失败 | 配置写错 → hook 不跑，Claude 照常 | 扩展抛错 → `pi` 直接 exit 1 |
| 进程边界 | 有（子进程/HTTP） | 无（同进程） |
| 观测数据 | `transcript_path` 可能滞后 | JSONL 直接读 |

### A.5 可以借到 Pi 桥接里的设计

1. **事件语义分层**：把 `tool_call` 当 `PreToolUse`，而不是 `PermissionRequest`。因为 Pi 没有「即将弹框」这个点，桥接必须自己决定哪些调用值得问人。
2. **默认回到人**：无决策 / 超时 / 桥接异常时，TUI 调 `ctx.ui.confirm`，不要默认放行，也不要默认阻断。
3. **显式失败策略**：给桥接加一个 `onFailure` 配置（`continue` / `block`），默认 `continue`（回落到人）。
4. **超时分层**：连接超时 1–2 秒；审批等待可长（Mo broker 120 秒）；两者分开，别用一个 timeout。
5. **HTTP 传输**：Claude 自己已经支持 `type: "http"`，Mo 可以考虑把 `hook-cli` 的子进程模式逐步换成 HTTP，与 Pi 桥接共用同一个本地端点。
6. **权限规则落盘**：Claude 的 `updatedPermissions` 可以做到「总是允许」持久化；Pi 侧没有等价物，需要 Mo 自己存规则。

## 7. 参考

- Pi Docs: <https://pi.dev/docs/latest>
- 会话格式: <https://pi.dev/docs/latest/session-format>
- 扩展: <https://pi.dev/docs/latest/extensions>
- JSON 事件流: <https://pi.dev/docs/latest/json>
- RPC: <https://pi.dev/docs/latest/rpc>
- RPC 命令: <https://pi.dev/docs/latest/rpc-commands>
- RPC 扩展 UI: <https://pi.dev/docs/latest/rpc-extension-ui>
- SDK: <https://pi.dev/docs/latest/sdk>
- 安全 / 项目信任: <https://pi.dev/docs/latest/security>
- Pi Packages: <https://pi.dev/docs/latest/packages>
- CLI: <https://pi.dev/docs/latest/cli>
- 社区 ACP 适配器: <https://github.com/victor-software-house/pi-acp>

本机验证记录：

- `pi --version` → 1.3.0
- `pi -e ./mo-test-ext.js --help` → 扩展注册的 `--mo-test` 出现在帮助里
- `pi --mode rpc --session-dir /tmp/pi-sessions-test -e ./mo-test-ext.js` → `session_start` 输出 sessionId、sessionFile、mode、trust 状态
- `pi --session-id mo-task-123` → 会话文件为 `<timestamp>_mo-task-123.jsonl`
