# 事件推送矩阵

> 只描述「事件 → 通知意图 → 通道」的默认行为。
> `mobile.mode` 只决定 HMS / 钉钉机器人是否注册，不改变 App 的 SSE 和 webhook，见文末。

## 1. 源事件 → 通知意图

映射唯一事实源：`core/contract.mjs` 的 `NOTIFY_POLICY`。

| 源事件 | 条件 | severity | kind | requiresAction | eventId |
|---|---|---|---|---|---|
| `approval.pending` | `kind=approval` | critical | `approval` | ✅ | ✅ broker id |
| `approval.pending` | `kind=question`（AskUserQuestion） | critical | `question` | ✅ | ✅ broker id |
| `pending.added` | `kind=approval`（DSH） | critical | `approval` | ✅ | ✅ eventId |
| `pending.added` | `kind=question`（DSH） | critical | `question` | ✅ | ✅ eventId |
| `notice` | hook 自己声明 | 来源决定 | 来源决定 | approval/question 或显式 | ❌ |
| `run.completed` | 一轮结束 | normal | `completed` | ❌ | ❌ |
| `run.failed` | 一轮失败 | critical | `error` | ✅ | ❌ |
| `run.canceled` | 一轮被中断 | normal | `canceled` | ❌ | ❌ |
| `session.*` / `run.started` / `pending.resolved` / `approval.resolved` / `source.error` | — | — | **不产生 notify** | — | — |

`notice` 的常见来源：

| hook / notification_type | kind | severity |
|---|---|---|
| `permission_prompt` / `worker_permission_prompt` | `approval` | critical |
| `idle_prompt` / `agent_needs_input` / `elicitation_*` | `question` | critical |
| `agent_completed` / Stop hook | `completed` | normal |
| `auth_storage_failure` | `error` | critical |
| `auth_success` / `quota_*` / `computer_use_*` / `model_refusal_fallback` | `info` | normal |
| `plugin_notification` / `push_notification` / 未知类型 | `attention` | critical（未知类型）或 normal |

> 对 `capabilities.approval = allow` 的 Agent，`permission_prompt` 会被主动跳过，避免和 PermissionRequest 的授权卡重复；对不支持审批的 Agent，它只发一条不带 eventId 的授权通知，通知上不能直接批准。

## 2. kind → 通道（默认配置）

| notify kind | App SSE | HMS 推送 | 钉钉机器人 | Webhook | 语音 |
|---|---|---|---|---|---|
| `approval` 授权请求 | ✅ 卡片 + 通知 | ✅ 纯通知 | ✅ 短码 A/D，15s 聚合 | ✅ | ❌ 走语音审批草稿 |
| `question` 等待回答 | ✅ 卡片（可选答案） | ✅ | ✅ 但只能 A/D，不能提交选项 | ✅ | ✅ 播报 |
| `error` 失败 | ✅ | ✅ | ✅ | ✅ | ✅ 播报 |
| `completed` 完成 | ✅ | ✅ | ❌ `events.completed=false` | ✅ | ❌ normal |
| `canceled` 已中断 | ✅ | ✅ | ❌ `events.canceled=false` | ✅ | ❌ normal |
| `info` 状态提醒 | ✅ | ✅ | ❌ normal < critical | ✅ | ❌ normal |
| `attention` 需关注 | ✅ | ✅ | ❌ `events.attention=false` | ✅ | ✅ 仅 critical 时 |

图例：✅ 默认推；❌ 默认不推。

### 各通道的实际行为

- **App SSE**
  - 所有 `notify` 意图都会到 App：in-app 横幅 + 系统通知；critical 会振动，开启语音时会 TTS。
  - `approval` / `question` 另外渲染成可操作卡片：`approval.pending` 走 `approvals.js`，`pending.added` 走 `app.js`。
  - Android 的 SSE 通知服务只在 `kind=approval` 且带 eventId 时加「允许一次 / 拒绝」按钮；question 没有按钮。
  - App 不在线（没有 SSE）时收不到这一路。
- **HMS 推送**
  - 服务端推送，**不过滤 kind / severity**，所有 `notify` 都发。
  - 通知体只有 title/body，**没有操作按钮**；点通知只打开 App。
  - 需要设备上报过 push token；App 被杀也能收。
- **钉钉机器人**
  - 默认只开 `approval` / `question` / `error`，且 severity ≥ critical；`completed` / `canceled` / `attention` 默认关，`info` 被 critical 门槛挡掉。
  - 还受静默时段、每分钟节流、月度预算闸门、绑定状态影响。
  - `approval` / `question` 会带短码（如 A3F2），回复 `A A3F2` / `D A3F2` 生效；同一个 session+kind 的多个待办在 15s 内合并成一条。
  - `question` 只能用 A/D 表示允许/拒绝，不能提交具体选项答案；DSH 的 question 目前也不会被钉钉答案路由处理。
  - `permission_prompt` 产生的无 eventId 授权通知，钉钉不会给短码，因此不能回复批准。
- **Webhook**（bark / dingtalk / wecom / feishu / generic）
  - `createWebhookChannel` **没有 kind/severity 过滤**，配置了 URL 就收所有 `notify`。
  - Bark 会把 critical 映射成 `critical` + alarm，normal 映射成 passive。
  - 注意：`notify.json` 里的 `dingtalk-bot` 条目没有 `url`，走的是钉钉机器人，不是 webhook。
- **语音**
  - 只念 critical，且明确跳过 `approval`（授权走语音草稿流程：念动作/目标 + 4 位口令）。
  - 所以 question / error / critical attention 会念；completed / canceled / info 不念。

## 3. 去重与聚合

- `Notifier` 按 `notificationKey` 去重：`run:<runId>` / `pending.added:<eventId>` / `approval.pending:<id>` / 其余按 seq。
- 去重是 **host 内部、跨通道之前** 的：同一事件不会让同一个通道收两次。
- 但 **不同通道之间不去重**：App + 钉钉都连着时，两边都会收到同一条事件。
- 钉钉有 15s 聚合；App / HMS / webhook 不聚合。
- 审批类：两边都能点，**先到的决定生效**；另一边的卡片可能变成过期状态（App 会收到 resolved 自动移除，钉钉消息不会撤回）。

## 4. `mobile.mode` 只影响两件事

| mode | HMS 推送 | 钉钉机器人 | App SSE | Webhook |
|---|---|---|---|---|
| `apk` | ✅ | ❌ | ✅ | ✅ |
| `dingtalk` | ❌ | ✅ | ✅ | ✅ |
| `both` | ✅ | ✅ | ✅ | ✅ |
| `none` | ❌ | ❌ | ✅ | ✅ |

所以「忽略 mode」时，默认矩阵按「HMS + 钉钉 + App SSE + webhook + 语音都可用」来理解；实际运行时再按上表裁掉 HMS 或钉钉。
