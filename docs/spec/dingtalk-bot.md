# 钉钉机器人 Stream 通道（单应用机器人）

- 状态：P0 / P1 已实现；P2 中群模式已具备，其余按决定延后
- 日期：2026-10-22
- 关联：[事件契约](./event-contract.md)、[`host/notify-webhook.mjs`](../../host/notify-webhook.mjs)、[`host/monitor-http.mjs`](../../host/monitor-http.mjs)、[`app/web/monitor.js`](../../app/web/monitor.js)

## 0. 结论

1. **只用一个企业内部应用机器人**（`robotCode`）：Stream 负责入站，`oToMessages/batchSend` / `groupMessages/send` 负责出站；不再引入自定义机器人，也不需要公网入口。
2. **只推送“需要你动手”的事件**：默认 `approval` / `question` / `error` 开，`completed` / `canceled` / `attention` 关；全部通过 `~/.mo-agent/notify.json` 的 `events` 开关配置。审批回复只认两条固定文本 `A <ID>` / `D <ID>`，完全匹配。
3. **双计次 + 预算闸门**：`local` 逐条计本机每一次钉钉接口/子进程调用（含失败、重试、token、建连），`billable` 只计平台会收费的成功 Webhook & Stream 调用；两者都落盘 `~/.mo-agent/usage.json`，监控屏分别展示“本地用了多少”和“计费额度用了多少”。
4. **首次引导以“扫码创建 + 零输入绑定”为 P0**：设置页复用钉钉开放平台的 **device-code 注册**（`init` → `begin` → `poll`）——扫码后自动创建“企业内部应用 + 机器人”，直接返回 `client_id` / `client_secret`；不依赖外部工具，也不需要公网入口。
5. **Stream 按官方协议接入**：gateway open → WSS → ACK，订阅 `TOPIC_ROBOT`。参考实现见 helloharness `core/lib/dingtalk-stream-transport.js`。**扫码只返回应用凭据，不返回用户身份**，所以绑定仍靠首条消息的 `senderStaffId`。

---

## 1. 目标与非目标

### 目标

- 手机没装 APK、或 App 没运行时，关键卡点（授权、提问、失败）仍能到人。
- 在钉钉里完成“批准 / 拒绝 / 查状态 / 切换会话”，形成闭环。
- 用量可见、可控：不因为无感调用撞上平台额度，也不因为额度耗尽而静默丢审批。
- 单机、单用户、零公网入口，符合 mo-agent 现有的局域网定位。
- **一次扫码完成“创建应用 + 配置机器人 + 发布 + 绑定”**，不让用户手抄 Client ID/Secret 或 userId。

### 非目标

- 不做 AI 卡片 / 流式更新（V2 再评估，成本高）。
- 不做多用户、多租户、团队共享审批。
- 不替代 HMS：HMS 仍可作为 Android 主通道，两者需要去重策略（见 §6.5）。
- 不做钉钉群里的多人协作决策。

---

## 2. 名词与边界

| 名词 | 含义 | 本方案是否使用 |
|---|---|---|
| 企业内部应用机器人 | 应用能力，`robotCode`，支持群聊 + 单聊，可收可发 | ✅ 唯一身份 |
| 自定义机器人（Custom Bot） | 群 webhook，`access_token`，只出不进，无 `robotCode` | ❌ 不再新增 |
| Stream | 出站 WSS 长连接，接收机器人消息 / 事件 / 卡片回调 | ✅ 入站 |
| HTTP 回调 | 钉钉 POST 到公网 HTTPS | ❌ 需要公网入口 |
| `sessionWebhook` | 入站消息里的临时回复 URL | ✅ 会话内回复兜底 |
| `openConversationId` / `userId` | 群 / 单聊的会话地址 | ✅ 绑定后持久化 |
| Webhook & Stream 用量 | 平台计费单位，按消息收发计 | ✅ 本地计次对象 |
| device-code 注册 | `init` / `begin` / `poll`，扫码自动创建应用 + 机器人 | ✅ 扫码创建 |
| Stream 协议 | gateway open → WSS → ACK，订阅 `TOPIC_ROBOT` | ✅ 入站 |
| `DWClient` / dingtalk-stream | 官方 Node SDK；也可用 `ws` 按协议自实现 | ✅ |
| `sessionWebhook` 回执 | `socketCallBackResponse(messageId)` | ✅ 避免 60s 重推 |

**边界**：本方案只覆盖中国大陆版钉钉（`api.dingtalk.com` / `open-dev.dingtalk.com`）。国际版（`api.dingtalk.io`）的套餐和接口路径不同，需要另做适配。

---

## 3. 总体架构

```
hub event
  → Notifier (core/notify.mjs)
  → dingtalk-bot channel
      ├─ accepts()：开关 / 严重级 / 静默时段 / 预算闸门
      ├─ 聚合器：同会话同 kind 合并，15s 窗口
      ├─ 出站：oToMessages/batchSend（单聊）
      │        groupMessages/send（群，可选）
      │        sessionWebhook（会话内回复兜底）
      ├─ 入站：Stream WSS ← 钉钉
      │        → 命令路由 → broker / runtime
      └─ 计次：usage meter → ~/.mo-agent/usage.json
monitor /monitor/state
  ← bot 状态 + usage.snapshot()
```

首次创建/绑定（只做一次）：

```
设置页「扫码创建」
  → POST /app/registration/init {source}
  → POST /app/registration/begin {nonce}
  → device_code + verification_uri_complete → 渲染二维码
  → 用户钉钉扫码授权
  → poll {device_code} → SUCCESS: client_id / client_secret
  → 凭证写入 ~/.mo-agent/notify.json（0600）
  → host 连 Stream；首条消息绑定 senderStaffId
```

一个机器人身份、两条方向：

- **出站**是普通 HTTPS 请求，受 `send.too.fast` 限流；
- **入站**是 host 主动连出去的 WSS，不需要公网 IP，断线自动重连。

---

## 4. 钉钉开放平台配置

### 4.0 扫码创建（P0，推荐）

目标：设置页扫一次码，自动创建“企业内部应用 + 机器人”，直接拿回 `client_id` / `client_secret`。**不依赖外部工具，不需要公网入口。**

#### 前置

- [ ] 你在目标钉钉组织里，且有权创建/授权企业内部应用（没有就找管理员）。
- [ ] 组织允许开放平台的扫码注册流程（`open-dev.dingtalk.com/openapp/registration/openClaw`）。
- [ ] host 能访问 `oapi.dingtalk.com`（出站 HTTPS）。

#### 接口（已核实）

| 步骤 | 请求 | 返回 |
|---|---|---|
| init | `POST https://oapi.dingtalk.com/app/registration/init`，body `{ source }` | `nonce` |
| begin | `POST https://oapi.dingtalk.com/app/registration/begin`，body `{ nonce }` | `device_code`、`verification_uri_complete`、`expires_in`、`interval` |
| poll | `POST https://oapi.dingtalk.com/app/registration/poll`，body `{ device_code }` | `status` = `WAITING` / `SUCCESS` / `FAIL` / `EXPIRED`；`SUCCESS` 带 `client_id` / `client_secret`；失败带 `fail_reason` |

- `source` 只是归属标签（如 `MO_AGENT`），接口不校验；二维码指向 `https://open-dev.dingtalk.com/openapp/registration/openClaw`。
- `device_code` 只留在 host 内存，不写日志、不进二维码。
- 参考实现：helloharness `core/lib/dingtalk-device.js`。

#### 流程

1. 设置页点「扫码创建机器人」→ `POST /setup/dingtalk/onboard/start`。
2. host 调 init → begin，拿 `device_code` + `verification_uri_complete`，用仓库已有的 `qrcode` 渲染二维码；页面轮询 `/setup/dingtalk/onboard/status`。
3. 用户手机钉钉扫码 → 确认创建/授权。
4. host 按 `interval` 轮询 poll：
   - `WAITING`：继续；
   - `SUCCESS`：取 `client_id` / `client_secret`，写 `~/.mo-agent/notify.json`（0600）；
   - `FAIL`：读 `fail_reason`；
   - `EXPIRED`：提示重扫；
   - 网络错误：2 分钟窗口内继续重试；总超时按 `expires_in`（默认 7200s）。
5. 凭证就绪 → host 连 Stream → 进入 5 分钟绑定窗口。
6. 用户给机器人发一句话；首条消息带回 `senderStaffId`、`robotCode`、`sessionWebhook`，host 绑定并回执。
7. 页面显示「完成」；监控屏显示已连接。

> 扫码只返回应用凭据，**不返回用户身份**；所以“绑定”仍然是首条消息的 `senderStaffId`，不是扫码人。`robotCode` 也从首条消息取——反正主动推送前必须先有一条会话。

#### 失败与回退

| 现象 | 处理 |
|---|---|
| 无权创建/授权应用 | 提示找管理员开通；走 §4.1–4.5 手动创建 |
| `init` / `begin` 失败 | 展示 errcode/errmsg；重试一次，仍失败走手动 |
| poll `FAIL` | 展示 `fail_reason`，重新扫码 |
| poll `EXPIRED` | 二维码过期，重新生成 |
| 网络抖动 | 2 分钟内继续 poll；超过则报错 |
| 机器人创建后搜不到 | 可能未发布/未生效；手动创建/发布兜底 |
| 凭证已存在 | 不重复创建，直接连 Stream；需要换应用时先清配置 |

> 正常路径（组织已开通、二维码有效、用户确认、网络正常）不会失败；上表是异常路径。手动创建入口默认收在“高级”里，不干扰主路径。

### 4.1 前置条件（手动兜底）

> 仅当 §4.0 走不通时使用；正常路径不需要手填任何凭证。

- [ ] 有钉钉组织（企业 / 团队），并且你是管理员，或已被授予开发者权限。
  - 没有权限时：管理员登录 [OA 管理后台](https://oa.dingtalk.com/) → **安全与权限 → 权限管理 → 管理组** → 添加管理组 → 给成员勾选开发者相关权限。
- [ ] 浏览器登录 [钉钉开发者后台](https://open-dev.dingtalk.com/)，右上角切换到目标组织。
- [ ] 想好机器人名称，例如 `mo-agent`（会显示在单聊/群聊里）。

### 4.2 创建内部应用

- [ ] **应用开发 → 企业内部应用 → 钉钉应用 → 创建应用**。
- [ ] 填写：
  - 应用名称：`mo-agent`
  - 应用描述：`本机 Agent 的确认与通知通道`
  - 图标：可选，240×240 PNG
- [ ] 保存后进入应用详情页。
- [ ] 打开 **基础信息 → 凭证与基础信息**，记录：
  - **Client ID（AppKey）**：`ding...`
  - **Client Secret（AppSecret）**：只显示一次，建议同时重置一份保存到密码管理器。

> 这两个值就是 host 配置里的 `clientId` / `clientSecret`。

### 4.3 添加并配置机器人

- [ ] **应用能力 → 添加能力 → 机器人**。
- [ ] 填写机器人信息：
  - 名称：`mo-agent`
  - 图标、简介（≤10 字）、描述（≤200 字）、预览图（PNG/JPG，≤2MB）
- [ ] **消息接收模式：Stream**（不要选 HTTP 模式）。
- [ ] 保存 / 发布机器人。
- [ ] 记录 **robotCode**（机器人编码，`ding...`），在机器人配置页或应用详情里可见。

> 只需配置机器人自身的 Stream 模式。V1 不依赖“事件订阅 → Stream”，卡片回调等 V2 再加。

### 4.4 申请发消息权限

- [ ] **权限管理** → 搜索 `qyapi_robot_sendmsg`（**机器人发送消息** / Permission to send messages with bots in your organization）→ 申请 / 开通。
- [ ] 如果控制台要求填写申请理由：`本机 Agent 向本人推送授权请求与任务结果`。
- [ ] V1 不需要通讯录权限：`userId` 从入站消息的 `senderStaffId` 获取。

### 4.5 发布应用

- [ ] **应用发布 → 版本管理与发布 → 创建版本**。
- [ ] 版本号：`1.0.0`；版本说明：`首个可用版本`。
- [ ] 发布内容：勾选 **机器人**（Bot）。
- [ ] 可见范围：**仅自己**（或你的部门）。范围越小越安全。
- [ ] **保存 → 发布**。
- [ ] 如果组织开启了发布审核，等待管理员通过。

> 只发布机器人即可，不需要上架工作台、不需要小程序/网页应用。

### 4.6 建立会话（首次绑定）

扫码创建成功后，页面会自动生成一个 **6 位配对码**：

- [ ] 打开钉钉，搜索机器人名称 `mo-agent`，进入单聊。
- [ ] 直接发送页面上的 6 位配对码（例如 `482913`）。
- [ ] 配对码正确 → host 立即绑定，回复「绑定成功」；页面变为「已绑定」。
- [ ] 配对码错误 → 回复「配对码不正确」；发错 5 次后作废，页面自动换一个新码。

手动创建（§4.1–4.5）也一样：打开「设置 → 钉钉机器人绑定」，页面自动生成配对码。

群聊（可选）：把机器人加进**内部群**，在群里 @ 它 发配对码；绑定的是该群的 `conversationId`。

> 搜不到机器人：检查应用是否已发布、可见范围是否包含你、机器人是否启用。配对码过期会自动刷新。

### 4.7 确认额度

- [ ] **开发者后台 → 资源管理**，查看：
  - `API 调用量` 本月已用 / 总额度
  - `Webhook & Stream 调用量` 本月已用 / 总额度
- [ ] 标准版参考值（2025-11-19 之后）：API **5,000 次/月**，Webhook & Stream **3,000 次/月**。
- [ ] 不够时再考虑：专业版 **9,800 元/年**，或企业应用增购包 **19,800 元/年**。

### 4.8 安全设置注意事项

- [ ] **不要**启用固定“服务器出口 IP”白名单：笔记本换 Wi-Fi / 热点会导致 API 全部失败。
- [ ] **不要**配置 HTTP 回调、AES 加密、公网域名：Stream 不需要。
- [ ] 机器人可见范围保持最小；不要拉进无关的大群。
- [ ] Client Secret 只保存在本机 `~/.mo-agent/notify.json`（0600），不要提交到仓库。
- [ ] 解绑时删除 `dingtalk.json` / `notify.json` 里的凭证，并断开 Stream。

### 4.9 验收（console 侧）

- [ ] 设置页扫码一次，自动完成创建、发布、凭证回填；失败可从中断处继续。
- [ ] 扫码完成后给机器人发任意一句话，host 日志出现入站事件并完成绑定。
- [ ] 桌面显示绑定用户，监控屏 `/monitor` 显示“钉钉通道：已连接”，本地调用 +1、其中计费 +1。
- [ ] host 触发一条测试确认，手机收到单聊消息。
- [ ] 资源管理的已用次数与本地 `billable` 大致对齐；`local` 会更大（含 token、建连、失败、重试）。

### 4.10 回填到 host

扫码创建成功时这一步自动完成。手动创建时，把 §4.2 / §4.3 的值填进 `~/.mo-agent/notify.json`（完整 schema 见 §5）：

```json
{
  "type": "dingtalk-bot",
  "enabled": true,
  "clientId": "ding...",
  "clientSecret": "***",
  "robotCode": "ding..."
}
```

首次入站后，host 自动补全 `target.userId` 和 `target.openConversationId`，不需要手填。

---

## 5. host 侧配置

### 5.1 `notify.json` 通道 schema

```jsonc
{
  // apk | dingtalk | both | none；由用户在设置页选择
  "mobile": { "mode": "dingtalk" },

  "channels": [
    {
      "type": "dingtalk-bot",
      "enabled": true,
      "clientId": "ding...",
      "clientSecret": "***",
      "robotCode": "ding...",

      // dm：单聊（推荐）；group：群聊
      "target": {
        "mode": "dm",
        "userId": "",                 // 首次入站自动写入
        "openConversationId": ""      // group 模式必填，首次入站自动写入
      },

      // 事件开关：只开“需要你动手”的
      "events": {
        "approval": true,
        "question": true,
        "error": true,
        "completed": false,
        "canceled": false,
        "attention": false
      },

      "severityMin": "critical",      // info | normal | critical
      "aggregateMs": 15000,           // 同会话同 kind 合并窗口；0 = 不合并
      "maxPerMinute": 10,             // 本地出站节流，留平台余量

      "quietHours": {
        "start": "23:30",
        "end": "08:00",
        "allow": ["approval"]         // 静默期内仍放行的 kind
      },

      "usage": {
        "monthlyLimit": 3000,
        "warnAt": 0.8,                // 80% 告警
        "confirmOnlyAt": 1.0,         // 100% 只留确认类
        "hardStopAt": 1.2,            // 120% 先提示再全停出站
        "stopOnQuotaError": true      // 检测到配额错误立即停止，不重试
      },

      // 安全
      "allowedUserIds": [],           // 空 = 仅绑定用户
      "allowedConversationIds": [],   // 空 = 仅绑定的会话
      "corpId": "",                   // 可选，校验 chatbotCorpId
      "allowFreeText": false,         // 自由文本是否当作 /run
      "audit": true,

      // 首次绑定
      "binding": {
        "windowMs": 300000,           // 点「开始绑定」后的有效期
        "autoBindFirst": true,        // 窗口内首条消息自动进入待确认
        "requireConfirm": false,      // 已废弃：现在用配对码绑定，不再桌面二次确认
        "codeTtlMs": 300000           // 绑定码有效期
      }
    }
  ]
}
```

### 5.2 默认值

| 字段 | 默认 | 说明 |
|---|---|---|
| `mobile.mode` | 沿用现状：有 HMS token → `apk`，否则 `none` | 不强制改变用户现有配置 |
| `enabled` | `false` | 没有凭证时不启用 |
| `target.mode` | `dm` | 单聊优先 |
| `events` | approval/question/error = true，其余 false | 只推需要动作的 |
| `severityMin` | `critical` | 与默认事件集一致 |
| `aggregateMs` | `15000` | 合并突发确认 |
| `maxPerMinute` | `10` | 低于平台限制 |
| `quietHours` | 关闭 | 需要时手动开 |
| `usage.monthlyLimit` | `3000` | 标准版 Webhook & Stream 额度 |
| `usage.stopOnQuotaError` | `true` | 配额错误只提示一次，随后停止出站 |
| `allowFreeText` | `false` | 防误触 |
| `binding.windowMs` | `300000` | 开始绑定后 5 分钟有效 |
| `binding.autoBindFirst` | `true` | 窗口内首条消息自动进入待确认 |
| `binding.requireConfirm` | `false` | 已废弃：配对码正确即绑定 |
| `binding.codeTtlMs` | `300000` | 绑定码 5 分钟有效、一次性 |

### 5.3 开关矩阵

| kind | 默认 | 建议 | 理由 |
|---|---|---|---|
| `approval` | ✅ | 必开 | 不处理任务就卡住 |
| `question` | ✅ | 必开 | 同上 |
| `error` | ✅ | 开 | 失败通常需要干预 |
| `completed` | ❌ | 关 | 可主动查，推送性价比低 |
| `canceled` | ❌ | 关 | 同上 |
| `attention` | ❌ | 按需 | hook 的“需要关注”，可能含噪音 |

> 没有“全部开启”这种默认。新增 kind 一律默认关闭，避免悄悄增加用量。

---

## 6. 事件路由

### 6.1 在契约里增加 `requiresAction`

在 [`core/contract.mjs`](../../core/contract.mjs) 的 `NOTIFY_POLICY` 返回值里增加布尔字段：

| kind | requiresAction |
|---|---|
| approval | `true` |
| question | `true` |
| error | `true` |
| completed / canceled | `false` |
| attention | 由来源声明，缺省 `false` |

用途：预算闸门在 100% 时只放行 `requiresAction === true` 的事件；通道过滤也以它为准，而不是靠 `severity` 猜。

### 6.2 过滤

`Notifier.handle` 在遍历通道前增加一次判断：

```js
if (channel.accepts && !channel.accepts(payload)) continue;
```

`dingtalk-bot.accepts(intent)` 依次检查：

1. `enabled` 且凭证齐全；
2. `events[intent.kind] !== false`；
3. `severity >= severityMin`；
4. 静默时段：允许列表外的直接丢弃（不排队，避免早上集中轰炸）；
5. 预算闸门（见 §9.5，只按 `billable`）；
6. 去重：`notificationKey` 已在 `Notifier.seen` 中，不重复。

### 6.3 聚合

按 `sessionId + kind` 聚合，窗口 `aggregateMs`：

```
⚠️ 授权请求 · 3 项
proj-x
1. #A3F2 执行 npm test
2. #B7C1 写入 12 个文件
3. #C9D0 等待回答：用哪种方案？

回复：A A3F2 同意 / D A3F2 拒绝
```

规则：

- 每条消息最多列 8 项，超出显示“另有 N 项，打开监控屏查看”。
- 短 ID 取 `eventId` 的 4 位大写十六进制，保证可回复、可核对。
- 聚合后的消息只计 1 次出站；项数不影响计次。
- `aggregateMs = 0` 时退化为逐条发送（仅调试用）。

### 6.4 静默时段

- 默认关闭；开启后按本机时区（`Asia/Shanghai`）判断。
- `allow` 列表内的事件照常发；其余直接丢弃并记日志。
- 不做事后补发，避免第二天早上堆一屏。

### 6.5 与 APK / HMS 的关系（二选一或并存）

用户在设置页选择 `mobile.mode`：

| mode | 行为 |
|---|---|
| `apk` | 只走 HMS/APK；没有 HMS token 时降级为 `none` 并提示 |
| `dingtalk` | 只走钉钉；不需要 HMS 开发者账号，也没有 APK 安装 |
| `both` | 两边都发；同一 `notificationKey` 在每个通道各发一次，用户接受双通知 |
| `none` | 不推手机，只保留桌面/本机 Web |

- **默认**：沿用现有配置；有 HMS token 时 `apk`，否则 `none`。由用户显式切换，不强制。
- HMS 涉及开发者账号、签名指纹、安全审核；钉钉涉及组织内创建应用。两者都是可选的，不配就不启用。
- `both` 模式下建议用 per-channel `events` 收缩，例如 HMS 接 `approval/error`、钉钉只接 `approval`，避免同一件事弹两次且内容重复。
- 现有的 `type: "dingtalk"`（自定义机器人）保留兼容，不再新增使用。

---

## 7. 出站

### 7.1 获取 access_token

```
POST https://api.dingtalk.com/v1.0/oauth2/accessToken
Content-Type: application/json

{ "appKey": "<clientId>", "appSecret": "<clientSecret>" }
```

- 缓存 `accessToken`，过期时间取 `expireIn - 60s`。
- 401 / `invalidParameter.token.invalid` 时强制刷新一次再重试。
- token 调用不计入 Webhook & Stream，但计入 API 调用量；本地单独记为 `kind: "token"`、`billable: false`。

> 钉钉有两套 token：`api.dingtalk.com` 的新机器人 API 用上面的 `oauth2/accessToken`；`sessionWebhook` / `oapi` 用 `https://oapi.dingtalk.com/gettoken?appkey=...&appsecret=...`。两套分别缓存，不要混用。

### 7.2 单聊推送（默认）

```
POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend
x-acs-dingtalk-access-token: <token>
Content-Type: application/json

{
  "robotCode": "ding...",
  "userIds": ["<userId>"],
  "msgKey": "sampleMarkdown",
  "msgParam": "{\"title\":\"授权请求\",\"text\":\"...\"}"
}
```

- 单次最多 20 个 `userIds`；本方案只用 1 个。
- 要求机器人已与该用户存在单聊会话，否则报 `robot.oto.notExist` / `chatbotId.notAllow.sendOTO`。
- `robotCode` 从首条入站消息里取（扫码创建接口只返回 clientId/clientSecret，不返回 robotCode）。
- 群 API 不支持 @；单聊不需要 @。

### 7.3 群推送（可选）

```
POST https://api.dingtalk.com/v1.0/robot/groupMessages/send
{ "robotCode": "...", "openConversationId": "cid...", "msgKey": "sampleMarkdown", "msgParam": "..." }
```

- `openConversationId` 从入站事件的 `conversationId` 获取。
- 官方暂不支持 @，需要 @ 时改用 `sessionWebhook` 或自定义机器人。

### 7.4 `sessionWebhook` 兜底

- 入站消息带 `sessionWebhook` 和 `sessionWebhookExpiredTime`（通常约 1.5 小时）。
- 在有效期内优先用它回复，延迟更低、还能 @ 人。
- 过期后回退到 §7.2 / §7.3；报 `session.expired` 时自动切换。

### 7.5 重试与超时

- 超时 8s。
- 可重试：网络错误、5xx、`send.too.fast`、`send.byToken.tooFast`；退避 1s / 2s / 4s，最多 3 次。
- 不重试：其余 4xx（参数、权限、会话不存在）。
- 每次成功调用计 1 次；失败不计（平台也不计失败调用）。

---

## 8. 入站与命令

### 8.1 Stream 连接

1. `POST https://api.dingtalk.com/v1.0/gateway/connections/open`
   body：`{ clientId, clientSecret, ua: "", subscriptions: [{ type: "EVENT", topic: "*" }, { type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }] }`
   返回 `endpoint` + `ticket`。
2. WSS 连接 `endpoint + "?ticket=" + ticket`；用 `ws`（仓库已有依赖）或 Node 22 全局 `WebSocket`。
3. 下行帧：`type=CALLBACK` 走机器人回调；`type=SYSTEM` 处理 `REGISTERED` / `KEEPALIVE` / `ping`。
4. 每个 CALLBACK/EVENT 帧按 `headers.messageId` 回 ACK（`code: 200`）；否则钉钉会在 60s 内重推。
5. 断线指数退避 1s → 60s，带抖动；状态暴露 `disconnected / connecting / connected / reconnecting / stopped`。
6. P0 直接用官方 `dingtalk-stream` SDK（`DWClient`：自动重连、心跳、ACK、去重）；不稳定时再按参考实现用 `ws` 自研（协议已核实）。参考：helloharness `core/lib/dingtalk-stream-transport.js`。

### 8.2 入站处理顺序

1. 校验 `chatbotCorpId`（配置了 `corpId` 时）。
2. 校验 `senderStaffId` 在 `allowedUserIds` 或已绑定用户内。
3. 校验 `conversationId` 在 `allowedConversationIds` 或已绑定会话内。
   > `waiting` 状态下，步骤 2/3 改为“窗口内首条消息”校验；绑定成功后恢复正常白名单。
4. 计次：`record({ channel: "dingtalk-bot", direction: "in", kind: "event", billable: true })`。
5. 按 `msgId` 去重（LRU 500，TTL 24h）。
6. **1 秒内 ACK**（按 `headers.messageId` 回 `code:200`），然后异步处理；长任务不能阻塞回调。
7. 匹配固定文本；命中才调用 `broker`，其他内容只回提示；回复优先 POST `sessionWebhook`，发送后调 `socketCallBackResponse(msgId, result)` 结束回执。
8. 没有 `sessionWebhook` 或已过期时，回退到 §7.2 / §7.3 的机器人 API。

### 8.3 绑定与首次引导

目标：从“打开设置”到“绑定完成”不超过 3 步；用户不需要手抄 userId，也不需要理解 Client ID。

#### 状态机

```
unbound --扫码创建 / 重新生成--> waiting(5min) --发送正确 6 位配对码--> bound
waiting --超时 / 5 次错误--> unbound
bound   --解绑--> unbound
```

- `waiting` 期间 host 生成 6 位配对码，只接受**完全匹配**的文本；其他消息回复“配对码不正确”。
- 发错 5 次后配对码作废，页面自动生成新码。
- 配对码只存在 host 内存与本机页面，不写日志、不进推送内容。
- `bound` 后固定审批回复生效。

绑定文件 `~/.mo-agent/dingtalk.json`（0600）：

```json
{
  "userId": "manager1234",
  "conversationId": "cid...",
  "conversationType": 1,
  "robotCode": "ding...",
  "boundAt": 1729...
}
```

- 单聊 `conversationType = 1`，群聊为 `2`。
- `openConversationId` 只在群模式需要；单聊用 `userId`。

#### 路径 A：扫码创建后（默认）

1. 凭证就绪后页面自动生成 6 位配对码。
2. 用户在钉钉搜索机器人，直接发送这个配对码。
3. 配对码正确 → 立即绑定；页面显示「已绑定」。
4. 配对码过期 → 页面自动换新码。

#### 路径 B：手动创建后

1. 打开「设置 → 钉钉机器人绑定」。
2. 页面自动生成配对码。
3. 用户在钉钉发送配对码 → 绑定。

两条路径都不需要点“开始绑定”，也不需要桌面二次确认。

#### 路径 C：二维码 / 深链（P1 spike）

- 如果机器人有可用的名片二维码或深链，设置页直接展示，扫码打开单聊，省掉“搜索名称”这一步。
- 验证点：
  1. 是否有稳定的 `dingtalk://` 深链能打开指定机器人的单聊；
  2. 是否携带 `robotCode` / 组织信息；
  3. 跨组织、未发布、不可见时的行为；
  4. 二维码能否由 host 本地生成（而不是只能从控制台下载图片）。
- 拿不到就退回路径 A。**不要伪造二维码**，也不要让用户扫一个本地 `127.0.0.1` 地址——手机访问不到。

#### 扫码创建与绑定的衔接（P0）

- 扫码创建走 §4.0：device-code 只返回 `client_id` / `client_secret`，**不返回用户身份**。
- 因此绑定仍由首条消息的 `senderStaffId` 完成；扫码只是省掉“手动创建应用 / 填凭据”。
- `robotCode`、`sessionWebhook` 也从首条消息取；主动推送前本来就必须先有会话。
- 凭证写 `notify.json`；绑定写 `dingtalk.json`；两者都 0600。
- 扫码失败或无创建权限时，回退到 §4.1–4.5 手动创建 + 路径 A2/B。

#### 安全约束

- `waiting` 默认 5 分钟，只允许一次绑定；超时自动关闭。
- 默认 `requireConfirm: true`，桌面确认绑定对象。
- 只允许与 `target.mode` 匹配的会话类型：`dm` 拒绝群消息，`group` 拒绝单聊（除非显式允许）。
- 已绑定时，其他用户的 `bind` 一律拒绝并记审计。

### 8.4 P0 回复：只认两条固定文本

P0 不做 `/run`、`/status`、`/use` 等通用指令，只支持审批闭环所需的两个固定回复：

| 固定文本 | 行为 |
|---|---|
| `A <ID>` | 同意对应 eventId；回执 `已同意 <ID>` |
| `D <ID>` | 拒绝对应 eventId；回执 `已拒绝 <ID>` |

规则：

- 先 `trim()`，`A/D` 不区分大小写，空格可选：`A A3F2`、`AA3F2`、`a a3f2` 都有效。
- 不做同义词、不做前缀/包含匹配、不解析自然语言：`同意 A3F2`、`A3F2`、`A A3F2 谢谢` 都不匹配。
- 兼容旧格式 `批准 <ID>` / `拒绝 <ID>`，避免旧消息失效。
- `<ID>` 是 4–6 位十六进制短 ID；冲突时升到 6 位。
- 不匹配：回 `未识别。请回复「A A3F2」表示同意，或「D A3F2」表示拒绝。`，不执行任何操作。
- 同一 ID 已处理过：回 `已处理 <ID>`，不重复执行。
- 审批成功后走现有 `approvals/broker.mjs`；失败回 `处理失败 <ID>：<原因>`。
- 其他指令（`/status`、`/pending`、`/use`、`/run`）全部 P2，P0 不实现。

> 推送消息里必须带可直接复制的短码，例如：
> `回复：A A3F2 同意 / D A3F2 拒绝`

### 8.5 审计

`~/.mo-agent/dingtalk-audit.log`，每行 JSON：

```json
{"at":1729...,"msgId":"msg...","userId":"...","conversationId":"...","command":"A A3F2","ok":true}
```

- 不记录消息全文，只记录命令和结果，避免把代码/路径写进日志。
- 日志按大小轮转，保留 7 天。

---

## 9. 计次（本地调用 + 平台计费）

### 9.1 两个计数器

为什么本地也要计：资源管理的数字是平台侧、按自然月、有延迟；本地计次能立刻回答“刚才这一小时到底发了多少请求、失败了几次、重试了几次”，也能在额度撞线前预警。

计数器按 channel 隔离（`channels["dingtalk-bot"]`），后续 HMS 等通道可以复用同一个 meter。

| 计数器 | 记什么 | 用途 |
|---|---|---|
| `local` | 本机每一次钉钉接口调用 / 子进程调用；成功、失败、重试、token、建连都算 | 看“本地用了多少”、排查、估算平台消耗 |
| `billable` | 平台会计入 Webhook & Stream 的成功调用 | 预算闸门、与资源管理对账 |

`local.total >= billable.total`，差值通常是 token、Stream 建连、失败、重试、device-code 轮询。

平台有两份额度：**API 调用量**（5,000/月）和 **Webhook & Stream**（3,000/月）。host 发出的 HTTP 可以逐条观测；创建应用时 device-code 的 `init/begin/poll` 计入 API 侧，平台额度仍以资源管理为准。

### 9.2 计数点

| 动作 | `api` | source | local | billable | 说明 |
|---|---|---|---|---|---|
| 换取 access_token | `oauth2/accessToken` | host | ✅ | ❌ | 计入 API 调用量，不计 Webhook & Stream |
| 发单聊 | `robot/oToMessages/batchSend` | host | ✅ | ✅ | 成功才 billable |
| 发群 | `robot/groupMessages/send` | host | ✅ | ✅ | 同上 |
| `sessionWebhook` 回复 | `robot/sendBySession` | host | ✅ | ✅ | 成功才 billable |
| Stream 建连 | `stream.connect` | host | ✅ | ❌ | 含重连 |
| 收到机器人消息 | `stream.event` | host | ✅ | ✅ | 每条入站事件 |
| device-code init/begin | `registration/init` / `registration/begin` | host | ✅ | ❌ | 创建应用时各 1 次 |
| device-code poll | `registration/poll` | host | ✅ | ❌ | 每次轮询都计；默认 2–5s 一次 |
| 失败 / 重试 | 同上 | — | ✅ | ❌ | 失败也计 local；重试每次单独计 |

> 聚合后的一条消息只计 1 次出站；不要把“逻辑通知条数”当调用次数。

### 9.3 埋点位置：唯一出口

- 新增 `host/dingtalk-http.mjs`，包装 `fetch`：
  - `begin({ api, method, source, meta })` → `end(id, { status, ok, ms, billable })`
  - 超时、断网、非 2xx 同样 `end({ ok:false, error })`
- **所有**钉钉 HTTP 必须走这个 wrapper；加一个测试/脚本扫描 `host/**/*.mjs`，禁止在 wrapper 之外直接 `fetch("https://api.dingtalk.com...")`。
- device-code 的 `init/begin/poll` 也走同一个 wrapper；`poll` 每次轮询都记一条，方便看“扫码等待期间本地打了多少请求”。
- Stream 在 `onopen` / `onmessage` 调 `meter.record(...)`；重连单独记一条 `stream.connect`。

### 9.4 存储

文件：`~/.mo-agent/usage.json`（0600，原子写：tmp + rename）。

```json
{
  "version": 2,
  "month": "2026-10",
  "timezone": "Asia/Shanghai",
  "channels": {
    "dingtalk-bot": {
      "local": {
        "total": 462,
        "today": 34,
        "ok": 446,
        "fail": 16,
        "retries": 2,
        "byApi": {
          "oauth2/accessToken": 12,
          "robot/oToMessages/batchSend": 80,
          "stream.event": 361,
          "registration/poll": 6,
          "stream.connect": 3
        },
        "byResult": { "ok": 446, "fail": 16, "retries": 2 },
        "byCategory": { "api": 21, "stream": 441 },
        "bySource": { "host": 462 },
        "days": { "2026-10-22": 34, "2026-10-21": 28 },
        "recent": [
          { "at": 1729..., "api": "robot/oToMessages/batchSend", "category": "stream", "ok": true, "ms": 123, "billable": true, "retry": false }
        ],
        "lastAt": 1729...
      },
      "billable": {
        "total": 441,
        "byDirection": { "in": 361, "out": 80 },
        "byKind": { "approval": 10, "question": 3, "error": 2, "event": 361 },
        "days": { "2026-10-22": 34 },
        "failures": 16,
        "lastAt": 1729...
      }
    }
  }
}
```

- `local` 是“本地用了多少”的权威；`billable` 是预算依据。
- `recent` 环形缓冲 200 条，只用于监控详情；超出丢弃。
- `local.days` / `billable.days` 保留 40 天；月份按 `Asia/Shanghai` 自然月切换，旧文件归档为 `usage-2026-09.json`，保留 12 个月。
- 写入去抖 3 秒；进程退出强制 flush；读取失败从 0 开始并告警，不阻塞通知。

### 9.5 预算闸门（只按 `billable`）

| 阈值 | 行为 |
|---|---|
| `warnAt`（默认 80%） | 日志 + 桌面通知（不走钉钉，避免递归）；监控屏变黄 |
| `confirmOnlyAt`（默认 100%） | 只放行 `approval` / `question`；其余丢弃并记日志 |
| `hardStopAt`（默认 120%） | 先提示（桌面通知 + 监控屏变红），然后停止全部出站；停止后不再重试 |

为什么允许到 120%：审批通道静默比超一点额度更糟。平台超额后有 5 天缓冲期，本地留出处理时间。

> **超额不是自动扣费**：平台先给最多 5 天缓冲，之后超出限额的调用会被限制（失败/限流），不会“发送成功再额外收费”。所以本地闸门防的是“审批静默丢失”，不是省钱装饰。
>
> 检测到配额/额度类错误后，立即置 `quotaExhausted = true`：提示一次、停止出站、进入冷却，不再对同一错误反复重试。扩容（购买增购包/专业版）后手动恢复；自动扩容入口后续再做。

### 9.6 对账

- `local` 与平台没有直接可比性；`billable` 对“开发者后台 → 资源管理”。
- 每月初人工对一次账；差异大时用 `usage.baseline` 手动补偿：

```json
{ "usage": { "baseline": { "month": "2026-10", "billable": 42 } } }
```

> `baseline` 只补 `billable`，不影响 `local`。

- 差异常见原因：平台重试、卡片更新、事件订阅、跨月边界、device-code 轮询的 API 调用。
- `local` 包含主机侧全部 HTTP 与 Stream 事件；平台 API 额度仍以资源管理为准。

### 9.7 查看方式

- 监控屏卡片：本月本地调用、其中计费/额度、今日、失败、Top 接口。
- `/monitor/state` 返回 `usage.local` 与 `usage.billable`。
- 可选本机命令：`node host/usage.mjs --channel dingtalk-bot --json`，只读，便于脚本排查。

---

## 10. 监控屏

### 10.1 `/monitor/state` 增加字段

在 [`host/monitor-http.mjs`](../../host/monitor-http.mjs) 的 `buildMonitorSnapshot` 里加入：

```js
dingtalk: {
  configured: true,
  enabled: true,
  connected: true,
  connecting: false,
  lastError: null,
  robotCode: "ding****",
  bound: {
    mode: "dm",
    userId: "man****",
    conversationId: "cid****"
  },
  binding: {
    state: "bound",              // unbound | waiting | pending_confirm | bound
    boundAt: 1729...,
    expiresAt: null,             // waiting 时的倒计时
    pendingNick: null,           // pending_confirm 时的发送者昵称
    codeHint: null               // waiting 时显示绑定码（脱敏）
  },
  onboarding: {
    state: "done",               // idle | qr_waiting | polling | saving | connecting | done | error
    step: "connect",             // init | begin | poll | save | connect | bind
    error: null,
    startedAt: 1729...
  },
  usage: {
    month: "2026-10",
    local: {
      total: 462,
      today: 34,
      ok: 446,
      fail: 16,
      retries: 2,
      byCategory: { api: 21, stream: 441 },
      byApi: {
        "stream.event": 361,
        "robot/oToMessages/batchSend": 80,
        "oauth2/accessToken": 12,
        "registration/poll": 6,
        "stream.connect": 3
      },
      bySource: { host: 462 }
    },
    billable: {
      total: 441,
      limit: 3000,
      percent: 0.147,
      today: 34,
      byDirection: { in: 361, out: 80 },
      byKind: { approval: 10, question: 3, error: 2 },
      failures: 16
    },
    recent: [
      { at: 1729..., api: "robot/oToMessages/batchSend", category: "stream", ok: true, ms: 123, billable: true, retry: false }
    ]
  },
  lastInboundAt: 1729...,
  lastOutboundAt: 1729...
}
```

- 所有 ID 脱敏，只显示前 3 + 后 2 位。
- 监控屏本身只允许回环地址 + 本机令牌访问（现有逻辑不变）。

### 10.2 UI 卡片

在 [`app/web/monitor.html`](../../app/web/monitor.html) 右侧栏、“需要你处理”之后新增：

```html
<section class="panel dingtalkPanel">
  <div class="panelHead">
    <h2>钉钉通道</h2>
    <span class="connTag" id="dtState">未配置</span>
  </div>
  <div class="usageBar"><i id="dtBar"></i></div>
  <div class="footRow"><span>绑定</span><b id="dtBind">未绑定</b></div>
  <div class="footRow"><span>本月本地调用</span><b id="dtLocal">0</b></div>
  <div class="footRow"><span>其中计费</span><b id="dtUsage">0 / 3000</b></div>
  <div class="footRow"><span>今日</span><b id="dtToday">0</b></div>
  <div class="footRow"><span>失败 / 重试</span><b id="dtFail">0 / 0</b></div>
  <div class="footRow"><span>入站 / 出站</span><b id="dtDir">0 / 0</b></div>
  <div class="footRow"><span>Top 接口</span><b id="dtTop">—</b></div>
  <details class="usageDetail">
    <summary>最近调用</summary>
    <div id="dtRecent" class="recentCalls">—</div>
  </details>
  <div class="footNote">本地调用逐条计；计费以钉钉资源管理为准。</div>
</section>
```

[`app/web/monitor.js`](../../app/web/monitor.js)：

- 增加 DOM 引用和 `renderDingtalk(data)`；
- 在 `applySnapshot` 末尾调用；
- 进度条颜色：<80% 绿、80–99% 黄、≥100% 红；
- 状态：未配置 / 待绑定 / 待确认 / 已连接 / 重连中 / 已断开；
- `dtBind`：未绑定 / 待确认·昵称 / 已绑定·昵称；`waiting` 时显示倒计时；
- `dtLocal` / `dtUsage` / `dtToday` / `dtFail` / `dtTop` 分别渲染本地调用、计费额度、今日、失败/重试、Top 接口；
- `dtRecent` 渲染 `usage.recent`（最多 20 条，显示时间、api、ms、ok）；
- 复用现有快照轮询，不新增接口。

[`app/web/monitor.css`](../../app/web/monitor.css) 增加 `.usageBar`、`.connTag` 两个样式即可。

---

## 11. 安全

- **身份**：只认 `senderStaffId`，不认昵称；可选校验 `chatbotCorpId`。
- **范围**：默认只允许绑定用户 + 绑定会话；群模式必须显式加白名单。
- **回复**：P0 只匹配两条固定文本；其他内容一律回提示，不执行、不转发。
- **二次确认**：危险操作回显摘要 + `确认 <id>`，防止手滑。
- **限流**：入站 10 条/分钟/用户，超出回“太频繁”。
- **密钥**：`clientSecret` 只存本机 0600 文件；日志、监控、错误信息一律脱敏。
- **审计**：记录命令与结果，不记录消息全文。
- **网络**：Stream 是出站 WSS，不开放入站端口；监控屏仅回环可访问。
- **提示注入**：入站文本不直接拼进 Agent prompt；P0 只做固定文本匹配，其他内容不进入 Agent。

---

## 12. 失败与降级

| 现象 | 处理 | 监控屏 |
|---|---|---|
| Stream 断线 | 指数退避重连；出站不受影响 | 重连中 |
| token 失效 | 刷新一次重试；仍失败则本轮跳过 | 降级 |
| 未绑定 | 跳过出站；提示“在设置页点开始绑定，再给机器人发一句话” | 待绑定 |
| `robot.oto.notExist` | 清空绑定，提示重新发消息 | 需重新绑定 |
| `chatbotId.notAllow.sendOTO` | 检查机器人是否启用/发布 | 配置错误 |
| `session.expired` | 切换到 API 发送 | 正常 |
| `send.too.fast` | 退避重试；仍失败则丢弃并计数失败 | 限流 |
| 额度到 100% | 只留 approval/question | 黄色 |
| 额度到 120% / 配额错误 | 提示一次后停止出站，不再重试 | 红色 |
| 消息过长 | 截断到 1000 字，附“打开监控屏查看详情” | — |

---

## 13. 代码改动清单

| 文件 | 改动 |
|---|---|
| `host/dingtalk-device.mjs` | 新增：device-code 注册（`init` / `begin` / `poll`）、二维码 URL、凭据写盘、超时/FAIL/EXPIRED 处理 |
| `host/dingtalk-stream.mjs` | 新增：封装官方 `dingtalk-stream` SDK；1s 轮询映射 connected/registered/reconnecting；ACK 与消息回调 |
| `host/dingtalk-bot.mjs` | 新增：绑定状态机、命令路由、出站、`accepts`、`sessionWebhook` 回复与回执 |
| `host/dingtalk-http.mjs` | 新增：带计次的 `fetch` 包装，所有钉钉 HTTP 的唯一出口 |
| `host/dingtalk-usage.mjs` | 新增：`local` / `billable` 双计数器、月度滚动、预算闸门、`recent` 环形缓冲 |
| `host/usage.mjs` | 可选：只读本机命令，`--channel dingtalk-bot --json` 直接看本地/计费用量 |
| `host/notify-webhook.mjs` | `loadNotifyChannels` 识别 `type: "dingtalk-bot"`；构造后调用 `start()` |
| `host/pair-http.mjs` | 设置页新增「钉钉」卡片：扫码创建、进度、开始绑定、倒计时、绑定码、状态；路由 `/setup/dingtalk/onboard/start`、`/setup/dingtalk/onboard/status`、`/setup/dingtalk/onboard/cancel`、`/setup/dingtalk/start`、`/setup/dingtalk/status`、`/setup/dingtalk/reset` |
| `core/notify.mjs` | `Notifier.handle` 增加 `channel.accepts` 钩子 |
| `core/contract.mjs` | `NOTIFY_POLICY` 增加 `requiresAction` |
| `host/index.mjs` | 构造/启动/停止 bot；把 `dingtalk`、`usage` 传入 server ctx |
| `host/monitor-http.mjs` | `buildMonitorSnapshot` 增加 `dingtalk` 字段 |
| `app/web/monitor.html` | 新增“钉钉通道”面板 |
| `app/web/monitor.js` | `renderDingtalk` + 快照接入 |
| `app/web/monitor.css` | 进度条 / 状态标签样式 |
| `docs/notify.example.json` | 保持现状（避免空凭证被注册）；schema 以本文 §5 为准 |
| `package.json` | `check` / `test` 增加新文件 |
| `host/dingtalk-device.test.mjs` | 单测：init/begin/poll 状态、二维码 URL、WAITING/SUCCESS/FAIL/EXPIRED、超时、凭据 0600 |
| `host/dingtalk-stream.test.mjs` | 单测：gateway/ACK、msgId 去重、重连退避、状态映射 |
| `host/dingtalk-http.test.mjs` | 单测：成功/失败/超时/重试都记 `local`；只有成功记 `billable`；wrapper 之外无旁路 |
| `host/dingtalk-bot.test.mjs` | 单测：过滤、聚合、命令、去重、重连退避 |
| `host/dingtalk-usage.test.mjs` | 单测：月度滚动、预算阈值、原子写 |

**依赖**：`qrcode` 已在依赖里，扫码创建二维码直接复用。Stream P0 使用官方 `dingtalk-stream` SDK（新增一个 npm 依赖）；不稳定时再按参考实现用已有 `ws` + 全局 `fetch` 自研。

---

## 14. 测试计划

### 单元

- 事件开关矩阵：每个 kind × 开关，是否发送。
- 聚合：同会话 3 条 → 1 条；不同会话 → 2 条；窗口边界。
- 静默时段：允许/不允许；跨午夜。
- 计次 `local`：成功/失败/超时/重试/token/建连/device-code poll 各 +1；跨月重置。
- 计次 `billable`：只有成功的发消息/入站事件 +1；失败为 0。
- 埋点唯一出口：扫描 `host/**/*.mjs`，除 `dingtalk-http.mjs` 外不得直接 `fetch("https://api.dingtalk.com"`。
- `recent` 环形缓冲上限 200，超出丢最旧。
- 预算：80% 告警、100% 只留确认、120% 全停。
- token 缓存与 401 刷新。
- 固定文本解析：`A A3F2` / `D B7C1` 命中；`AA3F2`、`a a3f2` 也命中；同义词、多余文本不匹配。
- 去重：同 `msgId` 只处理一次。
- 绑定：窗口内首条消息进入待确认；超时关闭；`bind <code>` 正确/错误/过期；用户变化需 `/rebind`。
- 绑定安全：`dm` 模式拒绝群消息；已绑定时他人 `bind` 被拒。
- 扫码创建：init/begin/poll 的 WAITING/SUCCESS/FAIL/EXPIRED、网络重试窗口、总超时。
- 扫码创建：QR URL 带 `source`；`device_code` 不进日志；凭据文件 0600。
- 扫码创建幂等：已有凭证时不重复创建。

### 集成

- 假 Stream 帧 → 命令 → `broker` 调用 → 回复。
- 假 fetch：200 / `send.too.fast` / 401 / 超时。
- 监控快照包含 `dingtalk` 字段且脱敏。

### 手工

- 设置页扫码一次，完成创建/发布/回填；中途取消后重新扫码能从断点继续。
- 手动兜底：按 §4.1–4.5 创建，点「开始绑定」→ 钉钉发 `hi` → 桌面确认。
- 绑定窗口过期后重新开始；`bind <code>` 兜底能成功。
- 触发一次真实授权，手机批准，任务继续。
- 监控屏数字随收发变化；断开网络后状态变为“重连中”。

---

## 15. 分期与工作量

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | 扫码创建（device-code）+ 手动兜底 + Stream 连接 + 零输入绑定 + 单聊推送 + 固定审批回复 + 双计次埋点 + 监控卡片 | 3–5 人日 |
| P1 | approval/question/error 全链路 + 聚合 + 静默 + 预算闸门 + 审计；打开机器人深链 1 天 spike | 4–5 人日 |
| P2 | 群模式 + `/run` + 多会话切换 + 卡片按钮（可选） | 2–3 人日 |
| 合计 | 可用闭环 | **9–13 人日** |

P0 / P1 已落地（device-code、Stream、固定审批回复、双计次、监控、设置页、聚合/闸门/审计）。P2 中群模式代码已具备但未开放产品入口；`/run` 等通用指令按决定不做。

不含钉钉控制台等待审核的时间。

---

## 16. 验收标准

- [ ] 设置页扫码一次完成应用创建；随后在钉钉发一句话即可完成绑定，无需手抄 userId/Secret。
- [ ] 手机没装 APK，也能在单聊收到授权请求。
- [ ] 回复 `A <ID>` / `D <ID>` 生效；`AA3F2`、`a a3f2` 也生效；同义词、多余文本不执行。
- [ ] 额度耗尽后提示一次并停止出站，监控屏变红，不再刷错误。
- [ ] 关闭 `completed` 开关后，完成事件不再推送；打开后恢复。
- [ ] 监控屏显示：通道状态、本月本地调用、其中计费/额度、今日、失败/重试、Top 接口、最近调用。
- [ ] 本地调用数与主机日志中的请求数一致；失败/重试也被计入 `local`，但不计 `billable`。
- [ ] 计次文件重启后不丢；跨月自动归零并归档。
- [ ] 额度到 100% 时只留确认类；到 120% 停止出站，监控屏变红。
- [ ] 非白名单用户发命令被拒绝，且不触发任何执行。
- [ ] 断网 1 分钟后恢复，Stream 自动重连，监控屏状态恢复“已连接”。

---

## 17. 风险与开放问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | 标准版 Webhook & Stream 仅 3,000 次/月 | 全量推送很快耗尽 | 默认只推确认类 + 聚合 + 本地闸门 |
| 2 | 本地计次与平台计数有差异 | 预算判断偏差 | 每月对账 + `baseline` 补偿 |
| 3 | 笔记本睡眠 / 断网 | 入站消息丢失，闭环中断 | 明确“桌面常驻”前提；监控屏告警 |
| 4 | 群模式隐私 | 审批内容被同群看到 | 默认单聊；群模式必须显式开启 |
| 5 | 自实现 Stream 协议的兼容性（gateway/ACK/重连） | 连接不稳定 | 优先官方 `dingtalk-stream` SDK；自实现按参考实现并做协议单测 |
| 6 | 钉钉接口/额度策略变更 | 功能失效 | 版本化接口路径；监控错误码；保留自定义机器人兜底 |
| 7 | 入站命令被伪造 | 本机被执行恶意操作 | 白名单 + 二次确认 + 审计 + `/run` 默认关闭 |
| 8 | 与 HMS 重复通知 | 同一事件弹两次 | 按平台路由；`dingtalk-bot` 只保留必须动作的事件 |
| 9 | device-code 注册接口属于开放平台注册流程，可能变更/限流 | 扫码创建不可用 | 接口版本化 + 错误码监控 + 手动创建兜底 |
| 10 | 绑定窗口被他人抢占 | 首次绑定到错误用户 | 5 分钟窗口 + 桌面确认 + 单聊/群类型校验 |
| 11 | device-code 返回的 `clientSecret` 只此一次 | 丢失/泄漏 | 只写 0600 文件；不进日志/二维码；支持在后台重置 |
| 12 | 创建后版本需审批 | 用户以为已可用 | 展示 `versionStatus`；未 `RELEASE` 明确提示“本地可连、线上不可搜” |

### 已定

- 移动端：APK / 钉钉 / 两者并存，由用户在设置页选择；默认沿用现有配置。
- 默认单聊；`error` 默认推送；绑定确认默认开。
- 扫码创建用 device-code，作为 P0 主路径；手动创建收在“高级”里兜底。
- Stream P0 用官方 `dingtalk-stream` SDK；不稳定再优化。
- 超额：平台是失败/限流，不会自动扣费；本地提示一次后停止出站，不再重试。扩容后续再做。
- 审批回复：要，仅两条固定文本 `A <ID>` / `D <ID>`，完全匹配。
- 通用指令（`/run`、`/status`、`/use`）P2 再做。

### 后续再定

- 群模式与群内多人审批。
- 自动扩容 / 增购包入口。
- 富交互（AI 卡片、按钮回调）。
- 多会话切换与自由文本指令。
