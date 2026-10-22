# 预研：WorkBuddy 能不能接进 mo-agent

日期：2026-10-21
范围：**WorkBuddy 桌面端**（/Applications/WorkBuddy.app，版本 5.8.3）。
明确排除：WorkBuddy 移动端 / 小程序、企微助理的云端侧、CodeBuddy IDE。
本机实测环境：macOS 26（arm64），WorkBuddy 5.8.3（Electron 37.10.3 / Node 22.21.1），
随包 CLI 运行时 2.161.0，已登录个人账号，已产生 2 轮真实会话。

## 0. 结论

**能接，而且 hook 侧几乎零成本；观测侧要新写一个解析器。**

WorkBuddy 桌面端底层是「Electron 壳 + CodeBuddy CLI 内核」。它的 hook 协议、
settings 文件、`PermissionRequest` 输出格式都和 Claude Code / Qoder CN 同构，
现有 `approvals/hook-cli.mjs` 可以原样复用；但桌面端写的 transcript 是
**新的 genie 格式**（`message` / `reasoning` / `function_call`），不是 Claude Code 的
`user / assistant + stop_reason`，所以不能直接挂 `adapters/claude-code.mjs`。

| 能力 | 结论 | 依据 |
|---|---|---|
| 观测会话 / 在不在跑 | ✅ 可做，需新解析器 | `~/.workbuddy/projects/*/*.jsonl`，genie 记录格式，实测存在 |
| 轮次完成（run.completed） | ⚠️ 可做，但要实测校准 | 没有 `stop_reason`；只能看 assistant `status:"completed"` 或 SQLite `sessions.status` |
| 等待授权 / 等待输入 | ✅ 官方 Hooks | `PermissionRequest` / `Notification` / `Stop` 等 22 个事件 |
| 手机远程批准 | ✅ 可做（待真机验证） | Hook 返回 `hookSpecificOutput.decision.behavior`，与现有 hook-cli 逐字一致 |
| 手机发指令 / 中断（control） | ❌ 桌面端没有公开面 | 桌面任务走私有本地 HTTP runtime；CLI 的 ACP / --serve 只能控制我们自己拉起的会话 |
| 会话标题 | ✅ 比 Claude 还省事 | transcript 自带 `ai-title`，SQLite `sessions.title` 兜底 |

建议：**P0 只做「观测 + 通知 + 远程批准」**，和 Claude Code / Qoder CN 同一定位；
不要为了控制去碰桌面端的私有 HTTP 端口。

但有一个产品层的前提要先说清楚：

> **WorkBuddy 自己已经支持企微远程批准。** 官方企微助理文档明确写了「确认操作：批准命令执行、
> 文件修改等需要确认的操作」，还支持手机下发任务、进度回传。mo-agent 对 WorkBuddy 的增量价值
> 不是「远程批准」本身，而是**跨 Agent 的统一面板 + 不依赖企业微信 + 语音/耳机通道**。
> 如果目标用户已经在用企微助理，适配优先级要下调；如果用户同时跑多个 Agent，仍然值得做。

## 1. 本机形态：桌面端就是 CLI 内核

三条实测证据：

1. **运行时**：`/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`
   直接可执行，`--version` 输出 `2.161.0`，`--help` 是完整的 CodeBuddy CLI 帮助；
2. **进程模型**：daemon 日志里每个会话都有
   `[conversation-runtime] composition resolved`、`[conversation-hooks] prewarm activate`，
   并按会话拉起 CLI worker；
3. **运行时会话文件**：`~/.workbuddy/sessions/<pid>.json` 由 CLI 自己注册，内容是
   `{pid, lastHeartbeat, sessionId, cwd, kind, meta:{socketPath}}`，本机当前有一个
   `kind:"prewarm"` 的预热进程。

所以适配对象是这套 CLI 内核，只是「谁在前面」从终端换成了 Electron。

## 2. 数据面（本机实测）

### 2.1 transcript —— 首选观测源

```
~/.workbuddy/projects/<project-slug>/<sessionId>.jsonl
```

project-slug 是 cwd 把 `/` 换成 `-`，例如：

```
~/.workbuddy/projects/Users-dev-WorkBuddy-2026-10-21-08-26-40/9b781026-….jsonl
```

实测一个正常结束的 2 轮会话，记录类型分布：

```
session-meta 4   message 4   reasoning 5
function_call 5  function_call_result 5
ai-title 1       file-history-snapshot 2
```

关键记录长这样（字段有删减）：

```jsonc
// 用户提问：夹在一大段 system-reminder 里，真正的问题在 <user_query>
{"type":"message","role":"user","content":[{"type":"input_text","text":"<system-reminder …>…</system-reminder>\n<user_query>call authx-mcp read</user_query>"}]}

// 模型思考（不进正文）
{"type":"reasoning","content":[],"rawContent":[{"type":"reasoning_text","text":"…"}]}

// 工具调用：独立记录，不是 assistant.content 里的 tool_use
{"type":"function_call","name":"ToolSearch","arguments":"{…}","callId":"call_…","cwd":"…"}

// 工具结果：独立记录
{"type":"function_call_result","name":"ToolSearch","callId":"call_…","status":"completed","output":{"type":"text","text":"…"}}

// 最终回答：content 里是 output_text，不是 text
{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"…"}]}

// 会话标题
{"type":"ai-title","aiTitle":"Call authx-mcp read","sessionId":"…","cwd":"…"}
```

与 Claude Code / Qoder CN 的差异（写适配器必须处理）：

| 维度 | Claude / Qoder | WorkBuddy（genie） |
|---|---|---|
| 一轮结束 | `assistant.message.stop_reason === "end_turn"` | **没有 stop_reason**；assistant 条目 `status:"completed"` |
| 工具调用 | `assistant.content[].type="tool_use"` | 独立 `function_call` 记录 |
| 工具结果 | `user.content[].type="tool_result"` | 独立 `function_call_result` 记录 |
| 回答正文 | `content[].type="text"` | `content[].type="output_text"` |
| 用户提问 | user 条目干净文本 | 一整段 `system-reminder` + `<user_query>`，必须剥离 |
| 标题 | 有的有 `ai-title`，Qoder 没有 | 有 `ai-title` |
| 权限模式 | user 条目 `permissionMode` | transcript 里没有，只在 SQLite |

**结论：不能继承 `TranscriptAdapter` 的解析逻辑**，需要新写一个 genie 解析器；
但文件发现、增量读取、去重、发布这些外围逻辑可以照抄/复用。
用户提问的提取规则建议：先找 `<user_query>…</user_query>`，没有就删掉所有
`<system-reminder>…</system-reminder>` 再取剩余文本。

### 2.2 SQLite —— 标题 / 状态 / 权限模式

```
~/.workbuddy/workbuddy.db
```

表：`sessions`、`workspaces`、`automations`、`automation_runs`、
`automation_runtime_state`、`automation_delivery_outbox`、`session_usage`、
`workspace_trust_decisions`、`buddy_snapshots`。

`sessions` 里有用的字段：

```
id, cwd, title, custom_title, status, permission_mode,
transport(local|cloud), source_mode, mode, model, updated_at, last_activity_at
```

实测行：`status="completed"`、`permission_mode="bypassPermissions"`、
`transport="local"`、`source_mode="craft"`。

用途：

- `title` / `custom_title`：比 ai-title 更稳定（用户可能改名）；
- `status`：run.completed 的兜底信号；
- `permission_mode`：卡片上显示 `bypassPermissions` / `default` / `auto`，远程批准前能先看一眼；
- `transport`：**cloud 会话可能没有本地 transcript**，这是观测盲区，需要实测。

读取方式和 Qoder CN 一样：优先 `node:sqlite`，Node 20 退到系统 `sqlite3`，
两者都没有就只靠 transcript。

### 2.3 运行时会话文件 —— 比 ps 更准的「谁在跑」

```
~/.workbuddy/sessions/<pid>.json
```

示例：

```json
{
  "pid": 27364,
  "lastHeartbeat": 1792584651333,
  "sessionId": "prewarm-wb-pool-…",
  "cwd": "/",
  "kind": "prewarm",
  "meta": {"status": "idle", "socketPath": "/tmp/codebuddy-prewarm-….sock"}
}
```

CLI 自己负责注册 / 心跳 / 退出清理。适配器可以直接读这个目录：

- `kind === "prewarm"` 的不是用户任务，过滤掉；
- 有 `sessionId` + `cwd` 的才是真实运行会话；
- 比 `ps` 匹配 `WorkBuddy` 准确（Electron 主进程常驻，ps 会一直命中）。

### 2.4 日志 —— hooks 确实被桌面端加载

`~/.workbuddy/logs/daemon.log` 里，每个会话启动时都有：

```
[conversation-runtime] composition resolved
  {"sessionId":"…","keys":["permissionMode","model","tools","settings","allowedTools"],
   "settingsKeys":["enabledPlugins","hooks","language", …]}
```

这说明桌面端会把 `~/.workbuddy/settings.json` 里的 `hooks` 一并读进运行时，
不是只有命令行才会读。

## 3. Hook / 审批面

### 3.1 配置文件

- 配置目录：`WORKBUDDY_CONFIG_DIR`，缺省 `~/.workbuddy`；
- 用户设置：`~/.workbuddy/settings.json`（就是现在放 `sandbox` 的那个文件）；
- 项目设置：`.codebuddy/settings.local.json`（注意项目级仍然叫 `.codebuddy`）；
- 设置白名单里明确包含 `hooks`（和 `permissions`、`sandbox` 同级）。

### 3.2 事件

从 CLI bundle 里提取到的完整事件枚举：

```
PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit,
Stop, StopFailure, SubagentStop, SubagentStart, PreCompact, PostCompact,
SessionStart, SessionEnd, WorktreeCreate, WorktreeRemove, ConfigChange,
InstructionsLoaded, PermissionRequest, PermissionDenied,
Elicitation, ElicitationResult, TaskCreated
```

配置结构是 Claude Code 同构：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {"type": "command", "command": "node …/hook-cli.mjs event PermissionRequest workbuddy", "timeout": 60}
        ]
      }
    ]
  }
}
```

### 3.3 PermissionRequest 的输入 / 输出

输入（实测代码里构造）：

```json
{
  "session_id": "…",
  "transcript_path": "…",
  "cwd": "…",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {…},
  "permission_suggestions": [ … ],
  "call_id": "…",
  "tool_use_id": "…"
}
```

输出（`executePermissionRequestHooks` 直接读这个字段）：

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

`deny` 时还可带 `message`；`allow` 时还可带 `updatedInput`。
**这正是 `approvals/hook-cli.mjs` 现在输出的格式**，一行都不用改。

关键代码路径（bundle 里可搜到）：

- `dispatchPermissionRequestHook` → `executePermissionRequestHooks`；
- 只有 hook 返回 `allow` / `deny` 才跳过桌面自己的授权框；
- 返回空 / 超时 → 回到桌面端原生提示（和 mo-agent 的 `defer` 设计一致）。

### 3.4 安装器改动

`host/agent-hooks.mjs` 目前：

```js
const MANAGED_KINDS = new Set(["claude-code", "qoder-cn"]);
```

加一个 `"workbuddy"`，再写一份 profile 即可。备份、`settings.hooks[event]` 合并、
卸载、状态查询这些逻辑全部复用。

注意：桌面端通常在**会话启动时**解析 settings，改完 `settings.json` 后
**新开一个任务**或重启 WorkBuddy 才生效；正在跑的会话不会热加载。

## 4. 控制面：为什么 P0 不做

- 桌面端没有公开的 prompt / cancel / interrupt 接口；任务由 daemon 通过私有本地
  HTTP runtime 驱动（日志里能看到随机端口和 `acquireLocalHttpRuntime`），要 token，
  属于私有接口，不适合作为产品依赖。
- CLI 确实支持 `--acp`、`--serve`（REST + Web UI + ACP over SSE）、`--a2a`、
  `--output-format stream-json`，但这些**只作用于我们自己拉起的会话**，
  接不上用户正在桌面端跑的会话。
- 企微助理可以远程下发任务，但那是 WorkBuddy 自己的通道，不是给第三方用的 API。

所以 profile 里 `capabilities.control = []`，手机端只保留「看 / 批准 / 拒绝」，
与 Claude Code、Qoder CN 桌面端一致。

## 5. 适配方案

### P0（建议先做，约 1.5–2 人日）

1. **profile**：`adapters/profiles/workbuddy.json`

   ```json
   {
     "id": "workbuddy",
     "label": "WorkBuddy",
     "module": "./workbuddy.mjs",
     "export": "WorkBuddyAdapter",
     "session": {"kind": "jsonl-transcript", "root": "~/.workbuddy/projects", "pattern": "*/*.jsonl"},
     "capabilities": {
       "observe": ["process", "transcript"],
       "runEnd": "inferred",
       "attention": "hook",
       "approval": "allow",
       "control": []
     },
     "hooks": {
       "kind": "workbuddy",
       "settingsFile": "~/.workbuddy/settings.json",
       "events": {
         "PermissionRequest": "approval.pending",
         "Notification": "notice"
       }
     }
   }
   ```

2. **adapter**：`adapters/workbuddy.mjs`
   - 文件发现 / 增量读取：复用 `TranscriptAdapter` 的外围逻辑（或抽公共基类）；
   - `applyLine` 重写：识别 `message(user/assistant)`、`function_call`、
     `function_call_result`、`ai-title`、`reasoning`；
   - 提问提取：`<user_query>` 优先，否则剥 `system-reminder`；
   - 回答提取：`output_text`；
   - 标题：`ai-title` → SQLite `sessions.title`；
   - 状态：用户消息 → working；assistant `status:"completed"` → completed；
     不确定时用「静默窗口」兜底（见风险）；
   - `history()`：user / assistant 成对，工具调用不单独算轮次。

3. **hooks**：
   - `MANAGED_KINDS` 加 `workbuddy`；
   - 事件只配 `PermissionRequest` + `Notification`，先不配 `Stop`
     （避免和 transcript 的完成信号重复）；
   - 托盘「一键配置 Agent…」加一行 WorkBuddy 即可。

4. **测试**：
   - 用脱敏后的真实 transcript 做 fixture（注意删掉 `identity_context` 和用户路径）；
   - 覆盖：首扫基线、运行中、完成、等待授权、工具调用、会话消失、重启恢复；
   - 断言只发白名单事件、`runId` 对齐、完成不重复。

### P1（验证后再做）

- SQLite 标题 / 状态增强（含 `custom_title`）；
- `~/.workbuddy/sessions/*.json` 运行时发现，过滤 prewarm；
- 与企微助理的去重：同一任务在企微已经弹过「确认操作」时，手机端不再重复推；
- cloud transport 会话的观测（如果确实没有本地 transcript，就明确不支持）。

## 6. 上线前必须实测的 5 件事

1. **hook 真的会执行**：往 `~/.workbuddy/settings.json` 加一个 `SessionStart`
   写 `/tmp/workbuddy-hook.log` 的 hook，开一个新任务，确认文件出现。
2. **PermissionRequest 能替桌面端做决定**：把权限模式切到 `default`，加一个
   返回 `allow` 的 hook，触发一次需要授权的 `Bash`，确认桌面端不再弹框。
3. **runEnd 是否等于「assistant 消息」**：跑一个多步任务（含 5+ 次工具调用），
   观察中间是否会写 assistant `message`；如果会，就需要静默窗口或 DB 状态兜底。
4. **重启 / 新会话才生效**：确认改 settings 后旧会话不受影响，新会话生效。
5. **企微助理是否重复通知**：绑定企微助理后，同一个授权是否同时推手机和企微。

## 7. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| genie transcript 是内部格式，随版本变 | 解析器随时可能坏 | 固定支持 5.8.x；fixture 回归；版本号写进 profile |
| assistant `message` 可能出现在一轮中间 | 误报「完成」 | 实测后用静默窗口 / SQLite `status` 兜底 |
| cloud transport 会话不落本地 JSONL | 远程任务看不到 | 实测；不支持就明确标注 |
| 企业策略 `disableAllHooks` / `allowManagedHooksOnly` | hook 不执行 | 状态页显示「hooks 被策略禁用」，不要静默失败 |
| `bypassPermissions` 模式 | 根本不弹授权 | 卡片显示权限模式；文档说明「询问审批」才有卡 |
| 企微助理已有远程批准 | 重复推送 / 价值重叠 | 去重 + 产品定位讲清楚 |
| hook 超时 / 桌面端被关闭 | 远程批准失败 | 沿用「拿不到决定就 defer 回本地」的设计 |

## 8. 落地记录（2026-10-21）

按 P0 已落地：

- `adapters/profiles/workbuddy.json`
- `adapters/workbuddy.mjs`（genie 解析、`<user_query>` 提取、静默窗口、history）
- `adapters/workbuddy.test.mjs`（11 个测试：观测、工具调用、静默窗口、提问提取、大文件、hook 配置、hook-cli 决策输出）
- `host/agent-hooks.mjs`：`MANAGED_KINDS` 加 `workbuddy`
- 手机端标签 / 配色、README、能力表、适配性矩阵

尚未完成（需要真实账号 / 真机）：

- `PermissionRequest` 真正拦下一次桌面授权（L1 → L2）；
- 多步任务验证静默窗口是否足够；
- 企微助理与 mo-agent 的重复通知去重。

## 9. 参考

- WorkBuddy 官网：<https://www.workbuddy.cn/>
- WorkBuddy Hooks Reference：<https://www.workbuddy.ai/docs/cli/hooks>
- WorkBuddy 企微助理（含远程确认操作）：<https://www.workbuddy.cn/docs/workbuddy/Wecom-Guide>
- CodeBuddy CLI 文档：<https://www.codebuddy.cn/docs/cli/hooks>
- 本机证据：
  - `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`
  - `~/.workbuddy/settings.json`
  - `~/.workbuddy/projects/*/*.jsonl`
  - `~/.workbuddy/sessions/*.json`
  - `~/.workbuddy/logs/daemon.log`
