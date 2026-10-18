# 统一事件与映射契约（v1 设计）

状态：**M1–M4 已落地**　日期：2026-10-18　关联：ADR-0001、ADR-0002、ADR-0003

## 1. 为什么需要这份设计

mo-agent 目前同时存在三套“事件语言”：

1. `core/events.mjs` 早期定义的 `agent.*`（AG-UI 风格，M4 已删除）；
2. DSH 适配器、Hub、SSE、手机端实际使用的 `session.upsert`、`session.removed`、`pending.*` 字面量；
3. 各 Agent profile 里声明、但没有代码读取的 hooks 映射。

结果是同一个事实由不同层各自解释：

- Claude 适配器发 `agent.updated`，手机端只订阅 `session.upsert`，实时状态丢失；
- Claude 完成发 `run.completed`，DSH 完成却由适配器直接发 `notice(completed)`，通知策略被拆成两份；
- DSH 一轮结束后状态是 `idle`，Claude 是 `completed`，手机端显示不一致；
- `run.completed` 没有 `runId`，只能靠“状态从 working 变 completed”推断一轮结束，快轮次会漏。

这些不是单点 bug，而是**规范事件、状态语义、映射责任**三个契约同时缺失。本设计把它们固定下来，并给出新增 Agent 的接入方式。

## 2. 目标与非目标

### 目标

- 只有一套**规范事件词汇表**，生产者和消费者都从同一处导入。
- 生产者只陈述事实；状态归约、通知分级、UI 渲染各自由一张映射表负责。
- 新增 Agent 只需要：profile + adapter + fixtures，**不改 core、不改 notify、不改手机端**。
- DSH / Claude Code / 未来的 L1 进程观测，对“运行中 / 已完成 / 空闲”给出一致语义。
- 所有契约可测试：事件白名单、字段形状、通知策略完整性、状态机。

### 非目标

- 不统一各厂商的原始协议（Claude hook、DSH RPC、ACP 各有自己的字段）。
- 不把厂商原始事件直接塞进规范枚举。
- 不做跨机器事件总线、持久化事件溯源、完整 JSON Schema 运行时校验。
- 不在本设计里实现代码；实现按第 12 节分阶段落地。

## 3. 分层模型

    ┌──────────────────────┐
    │ 厂商原始事件          │  Claude transcript / hook、DSH RPC、进程表、未来的 ACP
    │ (不稳定，厂商定义)     │
    └──────────┬───────────┘
               │ adapter 翻译（每 Agent 一份）
               ▼
    ┌──────────────────────┐
    │ 规范领域事件          │  session.* / run.* / pending.* / approval.* / notice / source.error
    │ (稳定，mo-agent 定义) │
    └──────────┬───────────┘
               │ Hub（唯一状态归约）
               ├──────────────► 状态快照 / SSE / 手机端
               ├──────────────► NOTIFY_POLICY ──► HMS / Webhook / 语音
               └──────────────► 审计日志 / 诊断

三条硬规则：

1. **适配器只发规范事件，不发 `notify`，不决定通知文案。**
2. **Hub 是唯一写会话状态的地方；`session.upsert` 是状态的唯一载体。**
3. **`run.*` 是一次性信号，`session.*` 是幂等状态；不能用状态 diff 代替信号。**

## 4. 规范事件 v1

### 4.1 事件表

| 事件 | 类别 | 生产者 | 关键字段 | 重放 | 用途 |
|---|---|---|---|---|---|
| `session.upsert` | 状态 | 任意 adapter | `sessionId, agent, title, status, running, updatedAt` | 是 | 会话快照/增量 |
| `session.removed` | 状态 | 任意 adapter | `sessionId` | 是 | 会话消失 |
| `run.started` | 信号 | 任意 adapter | `runId, sessionId, agent` | 否 | 一轮开始 |
| `run.completed` | 信号 | 任意 adapter | `runId, sessionId, agent, text, finishedAt` | 否 | 一轮正常结束 |
| `run.failed` | 信号 | 任意 adapter | `runId, sessionId, agent, text, finishedAt` | 否 | 一轮失败 |
| `run.canceled` | 信号 | 任意 adapter | `runId, sessionId, agent, finishedAt` | 否 | 一轮被中断 |
| `pending.added` | 状态 | DSH / 任意 | `eventId, sessionId, kind, question` | 是 | 等待回答/授权 |
| `pending.resolved` | 状态 | DSH / 任意 | `eventId, reason` | 是 | 待办结束 |
| `approval.pending` | 状态 | approvals | `id, sessionId, agentLabel, toolName, title` | 是 | 远程批准卡片 |
| `approval.resolved` | 状态 | approvals | `id, decision` | 是 | 批准结果 |
| `notice` | 信号 | 仅 hook 桥 | `kind, title, body, sessionId` | 否 | 人类可读的提醒（如 Claude Notification） |
| `source.error` | 状态 | 任意 adapter | `source, message` | 是 | 数据源异常 |
| `notify` | 派生 | Notifier | `severity, kind, title, body` | 否 | 通知出口，**禁止适配器发** |

### 4.2 已删除的别名

M4 起以下旧名**不再接受**，Hub 会按未知事件记警告并原样记录，适配器测试也会拦住：

- `agent.added` / `agent.updated` / `agent.removed`
- `agent.run.started` / `.completed` / `.failed` / `.canceled`
- `agent.needs.input` / `.auth`
- `session.started` / `dsh.error`

新代码只能使用 `session.*`、`run.*`、`pending.*`、`approval.*`、`notice`、`source.error`。

### 4.3 事件信封

统一信封，SSE 与内部总线共用：

```json
{
  "v": 1,
  "seq": 42,
  "at": 1792319586369,
  "type": "session.upsert",
  "payload": { "...": "..." }
}
```

约束：

- `seq` 单调递增，由 Hub 的 EventStore 分配；客户端用 `Last-Event-ID` / `since` 断点续传。
- `payload.sessionId` 必填（`notify` 与 `source.error` 除外）。
- 单条 payload 上限 32KB；超长文本由适配器截断（通知正文另限 400 字）。
- `v` 用于未来破坏性变更；服务端与客户端都忽略未知字段。

## 5. 会话状态模型

### 5.1 状态词表

继续使用 A2A TaskState + UI 的 `idle`：

| 状态 | 含义 | 是否终端 |
|---|---|---|
| `submitted` | 已提交，尚未开始 | 否 |
| `working` | 正在执行一轮 | 否 |
| `input-required` | 等待用户回答 | 否 |
| `auth-required` | 等待用户授权 | 否 |
| `completed` | 最近一轮正常结束 | 是 |
| `failed` | 最近一轮失败 | 是 |
| `canceled` | 最近一轮被中断 | 是 |
| `rejected` | 最近一轮被拒绝 | 是 |
| `idle` | **没有正在执行的轮次，且没有可判定的最近结果** | 仅 UI |

### 5.2 三条状态规则

**规则 S1：终端状态是“最近一轮的结果”，不是“进程还活着”。**

- 一轮结束且结果明确 → `completed` / `failed` / `canceled` / `rejected`；
- 终态保持到下一次 `run.started` 或 `session.removed`；
- `running` 是独立字段，表示“当前是否有一轮在跑”，不能从 `status` 反推。

**规则 S2：`idle` 不是 `completed` 的同义词。**

只有以下情况可以是 `idle`：

- 从未观察到该会话运行过（例如刚发现的空白会话）；
- 适配器能力不足以判定最近一轮结果（`runEnd: none`）；
- 会话被显式重置/清理。

**禁止**因为“现在没在跑”就把 `completed` 改成 `idle`。这正是 DSH 当前与 CC 不一致的根因。

**规则 S3：终态判定按适配器能力分级，不允许伪造。**

| `runEnd` 能力 | 判定方式 | 典型 Agent |
|---|---|---|
| `explicit` | 源里有明确结束标记：transcript `stop_reason=end_turn`、hook `Stop`、ACP 完成事件 | Claude Code |
| `inferred` | 不在运行 + 最近一轮有回答/轮次已推进 | DSH、部分日志型 Agent |
| `none` | 只能看进程在不在 | L1 进程发现 |

- `explicit`：直接置终态；
- `inferred`：允许置 `completed`，但必须在 profile 里声明，且要有 fixture 覆盖；
- `none`：进程退出后只能 `idle`，永远不要发 `run.completed`。

### 5.3 启动/重连时的状态恢复

- 适配器启动时先扫描历史，**不得补发历史轮次的完成通知**。第一轮扫描只建立基线（`firstScan`）。
- 能从源里证明最近一轮结果的（Claude transcript），恢复为终态；
- 不能证明的（DSH 重启、L1 进程），恢复为 `idle`，并保留 `lastPrompt` / `lastResponse` 供查看；
- 不允许把“启动时没在跑”推断成“刚完成”。

### 5.4 DSH 与 Claude 的统一结果

| 场景 | 现在 | 设计目标 |
|---|---|---|
| DSH 一轮结束 | `idle`（但发了完成通知） | `completed`，并发 `run.completed` |
| Claude 一轮结束 | `completed` | `completed`，并发 `run.completed` |
| DSH 重启后未运行 | `idle` | 若最近一轮有回答 → `completed`；否则 `idle` |
| Claude 重启后未运行 | `completed` | 保持 `completed`（transcript 可证明） |
| 从没跑过 | `idle` | `idle` |

实现 DSH 时，`applySession` 的 `!running` 分支改为：

```text
if (running)                         -> working
else if (pending.length > 0)         -> input-required / auth-required
else if (lastError)                  -> failed
else if (lastTurnHasResponse)        -> completed
else                                 -> idle
```

并在状态变为 `completed` 时发 `run.completed`，不再在适配器里直接发 `notice(completed)`。

## 6. 映射表

### 6.1 映射方向

    raw event ──► [ADAPTER_MAP] ──► canonical event
    canonical event ──► [STATE_MAP] ──► session state
    canonical event ──► [NOTIFY_POLICY] ──► notify intent
    canonical event ──► [UI_MAP] ──► 手机端渲染

四张表都必须显式、可枚举、可测试；禁止在业务代码里散落 if/else 和字符串。

### 6.2 适配器映射

每个 profile 声明自己能观测到什么：

```json
{
  "id": "claude-code",
  "label": "Claude Code",
  "module": "./claude-code.mjs",
  "export": "ClaudeCodeAdapter",
  "capabilities": {
    "observe": ["process", "transcript"],
    "runEnd": "explicit",
    "attention": "hook",
    "approval": "allow",
    "control": ["prompt", "cancel"]
  },
  "session": { "kind": "jsonl-transcript", "root": "~/.claude/projects" },
  "hooks": {
    "events": {
      "PermissionRequest": "approval.pending",
      "Notification": "notice"
    }
  }
}
```

规则：

- `hooks.events` 必须被 hook 桥实际读取；没有代码读取的声明视为无效配置。
- 同一轮完成只能有一个权威来源。Claude 以 transcript 为准，当前**不安装 `Stop` hook**；未来若安装，必须用同一 `runId` 去重。DSH 以轮次推进 + `!running` 为准。
- 适配器负责把字段映射成规范字段，例如 Claude 的“你说了什么”必须取真正的 `user` 消息，而不是 `last-prompt` 元数据。
- `capabilities.control` 必须同时约束后端与 UI：不含 `prompt` 的会话，手机端不显示发送按钮、`/api/prompt` 返回 409；不含 `cancel` 的会话同理。
- `session.upsert` 必须带 `agent` 与 `agentLabel`；手机端卡片和通知正文用它区分 DSH / Claude Code / 未来的 Agent。

### 6.3 状态映射

Hub 的 `applyEvent` 改为表驱动：

| 事件 | 状态动作 |
|---|---|
| `session.upsert` | 归一化并覆盖记录 |
| `session.removed` | 删除记录 |
| `run.*` | 只更新 `lastRun`/审计，不单独改 status（status 由同轮 `session.upsert` 携带） |
| `pending.*` | 更新会话的 `pending` 列表 |
| `approval.*` | 交给 approvals 中枢 |
| `source.error` | 记录数据源健康度 |

**顺序契约**：适配器结束一轮时，先发 `session.upsert`（`status=completed`、`runId` 一并写入），再发 `run.completed`。消费者只依赖 `seq` 顺序，不依赖两次网络到达顺序。

## 7. 通知策略

### 7.1 表驱动

`NOTIFY_POLICY` 是唯一的“事件 → 通知”映射：

| 事件 | severity | kind | 标题 | 正文 |
|---|---|---|---|---|
| `run.completed` | normal | completed | 任务完成 | `会话标题 · 回答摘要` |
| `run.failed` | critical | error | 出错了 | `会话标题 · 错误` |
| `run.canceled` | normal | canceled | 已中断 | `会话标题` |
| `pending.added`（approval） | critical | approval | 授权请求 | `会话 · 工具/动作` |
| `pending.added`（question） | critical | question | 等待回答 | `会话 · 问题` |
| `approval.pending` | critical | approval | 授权请求 | `Agent · 工具/动作` |
| `notice` | critical | attention | 提醒 | `会话 · 内容` |
| 其它 | — | — | — | 显式静默 |

规则：

- 每个规范事件必须出现在 `NOTIFY_POLICY` 或 `SILENT_EVENTS` 中；漏一个，契约测试失败。
- 适配器不得直接决定通知文案；通知正文统一截断（400 字）。
- DSH 不再发 `notice(completed)`；完成统一走 `run.completed`。

### 7.2 去重

- `run.*`：按 `runId` 去重；
- `pending.*` / `approval.*`：按 `eventId` / `id` 去重；
- `notice`：按来源事件 id，缺失时按 `seq`；
- 回放不触发通知：`run.*` 与 `notify` 不参与 SSE 断线重放；状态由 `session.upsert` 恢复。

## 8. SSE 与客户端

### 8.1 单一 `message` 信封（已落地）

旧格式是服务端 `event: <type>`，客户端手写订阅清单；漏一个名字就静默丢事件。新客户端改用：

```text
id: 42
event: message
data: {"v":1,"seq":42,"at":...,"type":"session.upsert","payload":{...}}
```

客户端：

```js
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  dispatch(evt.type, evt.payload);
};
```

**M4 起只发 `event: message`**：不再支持 named event，也不再有 `?envelope=1` 协商。
旧手机页面必须刷新/升级到这一版客户端。

收益：客户端不再维护事件名清单；新增事件类型不需要改前端订阅。

### 8.2 重放规则

| 事件 | 是否重放 |
|---|---|
| `session.upsert` / `session.removed` | 是 |
| `pending.added` / `pending.resolved` | 是 |
| `approval.pending` / `approval.resolved` | 是 |
| `run.*` / `notice` / `notify` | 否（瞬时信号） |
| `source.error` | 可选 |

重放的目的是恢复界面状态，不是重放通知。

## 9. 新增 Agent 的接入契约

### 9.1 新增一个 Agent 需要做什么

详细接入清单已落到 [adapters/README.md](../adapters/README.md) 与 [adapters/profiles/_template.json](../adapters/profiles/_template.json)。

1. **加 profile**：`adapters/profiles/<id>.json`
   - `id`、`label`、`enabled`
   - `module`：适配器入口（约定优于配置也可以）
   - `capabilities`：观测方式、`runEnd` 等级、attention、approval、control
   - `session`：数据源位置/格式
   - `hooks.events`：厂商 hook → 规范事件
2. **加 adapter**：`adapters/<id>.mjs`
   - 实现 `start()` / `stop()`；
   - 只通过 `emitSession()` / `emitRunStarted()` / `emitRunCompleted()` 等 helper 发事件；
   - 不写 UI 文案、不调 HMS、不发 `notify`；
   - 字段映射写在适配器内，并配注释说明厂商字段的坑（例如 Claude `last-prompt`）。
3. **加 fixtures + 测试**：`adapters/<id>.test.mjs`
   - 用脱敏后的真实日志/transcript；
   - 覆盖：首次扫描、运行中、完成、失败、等待输入、会话消失、重启恢复；
   - 断言事件类型白名单、必填字段、状态机、顺序、去重键。
4. **注册**：registry 按 profile 动态加载；不再每加一个 Agent 改一次 `createAdapters`。
5. **跑契约测试**：`npm test` 中的 contract suite 自动发现 profile，缺测试即失败。

### 9.2 验收标准

新增 Agent 的 PR 必须满足：

- [ ] 只发第 4 节白名单内的事件；
- [ ] 声明了 `capabilities.runEnd`，且行为与声明一致；
- [ ] 提供至少一份真实 fixture；
- [ ] 不修改 `core/`、`host/notify*`、`app/web/`；
- [ ] contract suite 全绿；
- [ ] README 能力表更新。

达到这个标准，后续加 Agent 就不需要再动通知策略、手机端和事件名。

### 9.3 能力降级

未来 Agent 可能只能做到 `runEnd: none`：

- 不发 `run.completed`；
- 状态只显示 `working` / `idle`；
- 不产生“任务完成”通知；
- UI 不应把它当成异常，只是能力较弱。

这样“加入新 Agent”不会被迫伪造它没有的能力。

## 10. 契约测试

已落地 `core/contract.test.mjs` 与 `adapters/contract.test.mjs`：

1. **词汇表测试**：`EVENT` 中的每个类型都在 `EVENT_META` 里有分类（state/signal/derived）与 schema。
2. **通知完整性**：每个 canonical 事件要么在 `NOTIFY_POLICY`，要么在 `SILENT_EVENTS`。
3. **适配器白名单**：跑 fixture，收集 `hub.store` 的事件类型，断言 ⊆ 允许集合。
4. **字段形状**：`session.upsert` 必含 `sessionId/title/status/running/updatedAt`；`run.*` 必含 `runId/sessionId`。
5. **状态机**：working → completed、working → failed、pending → resolved、restart → 不补发历史通知。
6. **顺序**：`run.completed` 之前必须有一条同 `runId` 的 `session.upsert`。
7. **客户端契约**：手机端不再有手写事件清单；SSE 信封字段与 `core/contract` 一致。

## 11. 与现有代码的对应关系

| 位置 | M1 后 | 后续 |
|---|---|---|
| `core/events.mjs` | re-export `contract.mjs`；别名已删除 | 无 |
| `adapters/dsh-monitor.mjs` | `session.upsert` + `run.completed`，completed 粘性 | 无 |
| `adapters/claude-code.mjs` | `session.upsert` + `runId`，terminal 判定显式化 | M3 `Stop` hook 按 runId 去重 |
| `core/notify.mjs` | 表驱动 `NOTIFY_POLICY`，契约测试保证完整 | 无 |
| `core/hub.mjs` | 入口归一化旧事件名，记录 `lastRun` | 未知事件严格拒绝 |
| `host/http.mjs` | 只发单 `message` 信封；重放过滤信号 | 无 |
| `app/web/app.js` / `approvals.js` | `onmessage` 按 type 分发，已删除手写清单 | 无 |
| `adapters/profiles/*.json` | 已声明 `module`/`export`/`capabilities`；registry 动态加载；hooks 桥读映射 | 增加更多能力门控 |

## 12. 落地计划

### M1：统一词汇与状态（不破坏手机端）——已落地

- [x] 新增 `core/contract.mjs`：`EVENT`、`LEGACY_ALIASES`、`EVENT_META`、`NOTIFY_POLICY`、`SILENT_EVENTS`。
- [x] `core/events.mjs` 改为 re-export，保留旧导入路径。
- [x] 替换适配器与 Hub 的字面量；Hub 入口归一化旧事件别名。
- [x] DSH：结束时置 `completed`，发 `run.completed`，删除 `notice(completed)`；`completed` 保持粘性，不再回退成 `idle`。
- [x] `runId`：`sessionId:turn:N`；通知按 `runId` 去重。
- [x] 契约测试 1–6；DSH/Claude 适配器测试覆盖完成、失败、快轮次、重启恢复。
- [x] profile 增加 `module` 与 `capabilities` 声明（动态加载仍是 M3）。
- [x] SSE 重放跳过 `notify` / `notice` / `run.*` 三类一次性信号。

实现备注：

- DSH 用适配器内的 `runSeq` 生成 `runId`，不依赖轮次文本；实时通道先报结束、轮询稍后拿到回复时，状态先显示 `completed`，完成信号等轮询补齐。
- DSH 的 `turnOutline.response` 只有约 120 字预览；完成时适配器调用 `session/page` 取最后一条 assistant 文本补全，先更新 `session.upsert`（详情层），再发 `run.completed`（通知）。超时/失败回退到预览文本。
- `run.completed` 之前必定先发同 `runId` 的 `session.upsert`；Hub 只把 `run.*` 记为 `lastRun`，不单独改状态。
- 契约测试当前 211 项全绿（`npm test`）。

### M2：SSE 单信封 + 客户端通用分发——已落地

- [x] 服务端支持 `?envelope=1`，发 `event: message`；旧 named event 保留迁移窗口。
- [x] 手机端 `app.js` / `approvals.js` 改为 `onmessage` 按 type dispatch，删除手写清单。
- [x] 事件信封补 `v: 1`。
- [x] 重放规则按 8.2 执行（M1 已提前完成）。
- [x] `host/http.test.mjs` 覆盖新旧两种帧格式。

### M3：profile 驱动接入——已落地

- [x] registry 按 `profile.module` + `profile.export` 动态加载，新增 Agent 不改 registry。
- [x] 能力声明参与行为门控：`runEnd: none` 只更新状态，不发 `run.*`（DSH/Claude 各有测试）。
- [x] hooks 桥读取 `profile.hooks.events`；`hook-cli.mjs event <HookEvent> <agent>`，旧 `permission`/`notify` 命令兼容。
- [x] 提供 [adapters/profiles/_template.json](../adapters/profiles/_template.json) 与 [adapters/README.md](../adapters/README.md)。
- [x] 打包脚本把 `adapters/*.mjs` 与 `core/*.mjs` 复制进运行时，动态 import 在 Bun 单文件包里可用。

### M4：清理——已落地

- [x] 删除 `agent.*` / `agent.needs.*` / `session.started` / `dsh.error` 别名。
- [x] 删除重复通知分支：`notice` 只做 attention，完成/失败统一走 `run.*`。
- [x] 删除旧 named SSE：只发 `event: message`，客户端不再带 `?envelope=1`。
- [x] 新增 `scripts/gen-capabilities.mjs`，生成 [docs/capabilities.md](../capabilities.md)；`npm run check` 会校验是否最新。
- [x] 测试更新：旧事件名不再被接受、SSE 只有 message 帧。

## 13. 待决问题

1. 终态跨 host 重启是否要持久化？本设计建议：能证明就恢复，不能证明就 `idle`，不伪造。
2. `session.upsert` 是否承载 `lastRun`（`runId/outcome/finishedAt`）？建议承载，方便 UI 与调试。
3. `notice` 是否改名为 `attention.requested`？v1 保留 `notice`，降低迁移成本。
4. ~~SSE 单信封切换是否与手机 App 发版绑定？~~ M4 已完成：只保留单信封，手机端需刷新/升级。

## 14. 附：一轮完成的时序

```text
adapter 读到 end_turn
        │
        ├─ emit session.upsert { status: "completed", running: false, runId: "s1:turn:3", ... }
        │
        ├─ emit run.completed  { runId: "s1:turn:3", sessionId: "s1", text: "..." }
        │
        ▼
Hub: 更新会话状态，分配 seq
        │
        ├─ SSE (message) ──► 手机端立即更新状态/回答
        └─ Notifier ──► NOTIFY_POLICY ──► HMS「任务完成」（按 runId 去重）
```

关键点：**状态先落，信号后发；手机端不靠信号改状态，通知不靠状态 diff 触发。**
