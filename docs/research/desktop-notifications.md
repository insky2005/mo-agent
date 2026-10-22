# 预研：桌面端系统通知与「点击打开对应窗口」

日期：2026-10-19　环境：macOS 26.5 / arm64 / Electrobun 2.0.2 / cottontail 0.7.1

## 0. 结论先行

1. **能加，但「显示通知」和「点击后精确打开对应窗口」是两件事。**
   - 显示通知：Electrobun 已内置 `Utils.showNotification`，接上 host 的 notify 事件即可，约 **1–1.5 人日**。
   - 点击跳转：内置 API **没有点击回调、没有 userInfo、没有 identifier**；系统点击最多把 App 激活，无法知道用户点的是哪一条通知。要精确跳转必须自己补一层原生通知 delegate，约 **2–4 人日**，且有几个 macOS 生命周期风险。
2. **推荐分两阶段做**：
   - P0：桌面显示系统通知（授权请求 / 等待回答 / 完成 / 失败），点击先只负责把 mo-agent 面板拉到前台。**1.5–2 人日**。
   - P1：原生点击回调 + 通知携带 target + 新增「待处理」窗口/会话深链。**再加 3–5 人日**。
   - 全量（含开关、与手机推送去重、权限引导）约 **5–8 人日**。
3. **最大阻点不是「发通知」，是「点哪条、开哪个窗」**：Electrobun 内置通知是 fire-and-forget；桌面端目前也没有审批/会话详情窗口，只有设置、Agent 配置、日志三个窗口。参考 `desktop/src/bun/index.ts:353`、`:427`。
4. **建议先做 1 天 spike**：验证 macOS 26 + ad-hoc 签名下的通知权限、点击是否触发 `reopen`、以及自建 delegate 能否拿到点击 payload。验证通过再排 P1。

## 1. 现状

### 1.1 host 已经有统一通知出口

- `core/notify.mjs:25` 的 `Notifier` 订阅 hub 事件，按 `core/contract.mjs:147` 的 `NOTIFY_POLICY` 生成 `notify` 事件并广播。
- notify payload 已经带齐跳转所需字段：`kind`、`severity`、`title`、`body`、`eventId`、`sessionId`、`runId`、`agent`、`agentLabel`、`sessionTitle`。
- 现有通道：HMS 手机推送、Bark/钉钉/企业微信/飞书/generic webhook、语音播报。见 `host/index.mjs:59`、`host/notify-webhook.mjs`、`host/hms-push.mjs`。
- 手机 HMS 通知点击目前是「打开 App 首页」（`host/hms-push.mjs` 的 `click_action.type = 3`），本身也没有精确到某条审批。

### 1.2 桌面壳目前完全没有接通知

- `desktop/src/bun/index.ts` 只 import 了 `Tray / BrowserWindow / Utils / Screen / GlobalShortcut / ApplicationMenu / app`，没有任何 notification 调用。
- 桌面壳也没有订阅 host 的 SSE。它只通过 `fetch` 调 `/api/health` 和少量 `/local/*` 接口。
- 现有窗口：
  - 设置面板：`/setup`
  - 一键配置 Agent：`/agents`
  - 日志：`/logs`
  - 语音浮层 / 语音球：`/voice-overlay.html`、`/voice-orb.html`
- 没有「待批准」「会话详情」窗口；通知点击没有天然落点。

### 1.3 认证边界

- `/api/events`、`/api/state` 需要**设备令牌**（`x-mo-agent-token` 或 `?token=`），见 `host/http.mjs:386`。
- 桌面壳手里只有**本机令牌** `~/.mo-agent/session.json`（`host/index.mjs:476`），不能直接访问 `/api/*`。
- 因此桌面要收 notify 事件，需要新增一个本机令牌可访问的事件流（例如 `/local/events`），或者让桌面自动换取一个设备令牌。前者更简单，且不会把桌面算成「手机在线」影响 broker 的 DEFER 判断。

## 2. 能力验证：Electrobun 到底支不支持点击

### 2.1 公开 API：只有显示，没有点击

`desktop/.hutch/devkit/api/sdks/main/core/Utils.ts:66`：

```ts
export type NotificationOptions = {
  title: string;
  body?: string;
  subtitle?: string;
  silent?: boolean;
};
```

`Utils.showNotification` 只把这些字段转给原生 `showNotification(title, body, subtitle, silent)`（`Utils.ts:119`）。**没有 id、没有 userInfo、没有 category、没有 onClick。**

Electrobun 的 App 事件只有 `application-menu-clicked`、`context-menu-clicked`、`open-url`、`reopen`、`before-quit`（`desktop/.hutch/devkit/api/sdks/main/events/ApplicationEvents.ts:6`）。**没有 notification-clicked。**

### 2.2 已安装二进制的验证

对 `/Applications/mo-agent.app/Contents/MacOS/libNativeWrapper.dylib` 做静态检查：

- `nm` 能看到 `_showNotification`，以及 `NSUserNotificationCenter` / `UNUserNotificationCenter` 的类引用；
- 但 `AppDelegate` 只有 3 个方法：
  - `applicationShouldTerminate:`
  - `application:openURLs:`
  - `applicationShouldHandleReopen:hasVisibleWindows:`
- 没有 `UNUserNotificationCenterDelegate` 的 `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:`，也没有 `NSUserNotificationCenterDelegate` 的 `userNotificationCenter:didActivateNotification:`。

结论：**内置通知点击不会带回 payload。** 点击最多走系统默认的「激活 App」，可能触发 `applicationShouldHandleReopen` → Electrobun 的 `reopen`，也可能只是把 App 带到前台；即使触发 `reopen`，也分不清点的是哪一条通知。

### 2.3 权限

- 原生二进制里已有 `requestAuthorizationWithOptions` 和降级到 legacy API 的逻辑，首次调用 `Utils.showNotification` 应该会弹通知权限。
- 但当前 App 是 **ad-hoc 签名**（`scripts/build-desktop.sh` 末尾 `codesign --force --deep --sign -`）。README 已记录麦克风权限在重建/升级后可能重置；通知权限是否同样受签名/重建影响需要实测。
- 当前 `Info.plist` 有 `LSUIElement=true`，没有通知相关用途说明（通知不需要 usage description，但需要用户在系统设置里允许）。

## 3. 方案对比

| 方案 | 点击精确跳转 | 复杂度 | 主要风险 | 建议 |
|---|---|---|---|---|
| A. 只用 `Utils.showNotification` | ❌ 只能激活 App | 低（0.5–1 人日） | 不知道点的是哪条；可能连 `reopen` 都不触发 | P0 显示可用 |
| B. 内置通知 + 监听 `reopen` | ⚠️ 只能开「最近一条」或通知中心 | 低（+0.5 人日） | 依赖系统行为；多条通知会错配 | 可做降级兜底 |
| C. 主进程用 `bun:ffi` 调 `NSUserNotificationCenter` / `UNUserNotificationCenter`，自建 delegate | ✅ 可带 userInfo | 中高（2–4 人日） | ObjC runtime / block completion / 启动时机；但 bundle identity 最正 | 推荐 P1 主路径 |
| D. 独立 Swift 通知 helper（类似语音桥） | ✅ 可带 userInfo | 中（2–3 人日） | 独立 bundle id/权限归属；helper 生命周期；点击可能启动 helper 而不是主 App | 备选 |
| E. 捆绑 terminal-notifier / alerter | ✅ 部分支持 `-execute` | 低中（1–2 人日） | 第三方二进制、签名、品牌显示为 helper；macOS 26 兼容性未知 | 不推荐长期 |

### 方案 C 的技术要点

项目已经有 `bun:ffi` + `dlopen` + `JSCallback` 的成熟用法（Carbon 全局快捷键，`desktop/src/bun/index.ts:997`），可以复用同样的模式：

1. `dlopen` `libobjc` / `UserNotifications.framework`，拿 `objc_getClass`、`sel_registerName`、`objc_msgSend`。
2. `objc_allocateClassPair` 建一个 delegate 类，`class_addMethod` 注册点击回调，`JSCallback({ threadsafe: true })` 把点击事件写进一个 pending 变量，由现有 80ms 轮询（`:1507`）在 JS 线程处理。
3. 发通知时用 `UNMutableNotificationContent` 设置 `title/body/userInfo`，`UNNotificationRequest` 的 identifier 用 `notify` 的 `eventId` 或 `runId`。
4. 点击回调从 `response.notification.request.content.userInfo` 取 target，再调用桌面壳的 `openPanel(target)`。

两个需要提前验证的坑：

- **completionHandler**：现代 delegate 方法要求调用 completion block。Bun FFI 直接调用 block 比较麻烦；如果忽略可能只是系统日志警告，但需要实测。
- **启动时机**：Apple 要求 delegate 在 App 启动完成前设置；而我们的 JS 主进程是在原生 App 启动之后才跑。**App 未运行时点击通知，payload 可能丢**。托盘常驻时问题不大；退出 App 后点击只能保证启动，不能保证定位到具体通知。

### 方案 D 的注意点

语音桥已经证明「Swift + 独立 .app + ad-hoc 签名」这条路能走（`scripts/build-voice-bridge.sh`）。但通知 helper 如果用自己的 bundle id：

- 系统通知设置里会出现第二个 App；
- 点击通知可能启动的是 helper，不是 mo-agent 主 App；
- helper 要常驻、要跟主 App 同生共死，生命周期更复杂。

如果要做，建议 helper 只负责「收点击」，收到后 `open "mo-agent://focus?...` 或 POST 本机接口，主 App 再开窗。

## 4. 推荐的落地架构

```
hub event
  → Notifier (core/notify.mjs)
  → notify payload
      ├─ 现有通道：HMS / webhook / 语音
      └─ 新增：/local/events（本机令牌 SSE）
                → desktop 主进程
                    → Utils.showNotification（P0）
                    → 原生 delegate 收点击（P1）
                        → 解析 target
                        → 打开「待处理」窗口 / 会话详情
```

### 4.1 host 侧改动

1. **新增 `GET /local/events`**
   - 用 `localToken` 鉴权（query/header 均可）。
   - 复用 `host/http.mjs:543` 的 `streamEvents`，但 **不要**走 `onOpen` 的 `clients += 1`，否则桌面会被当成手机在线，影响 remote approval 的 DEFER 逻辑。
   - 与 `/api/events` 一样，不回放 `notify` / `notice` / `run.*`，避免重连重复弹通知。
2. **（可选）通知开关**
   - 在 `~/.mo-agent/notify.json` 增加 `desktop: { enabled: true, severity: "critical" }`，或独立 `~/.mo-agent/desktop.json`。
   - host 不需要知道桌面在线状态；桌面自己过滤即可。
3. **（P1）新增/复用一个「待处理」页面**
   - 最小方案：桌面窗口加载 `/attention?token=<localToken>&focus=approval:<eventId>`。
   - 页面通过本机令牌调 `/local/state`（或复用 `/api/state` 但加本机令牌旁路）拉 pending approvals/questions + 会话。
   - 需要新增 `/local/state` 或在 `/api/state` 上允许 `localAuthed`。**推荐新增 `/local/state`**，边界清晰。

### 4.2 desktop 侧改动

1. 启动时读 `~/.mo-agent/session.json` 拿 localToken，连 `/local/events`。
2. 收到 `notify`：
   - `Utils.showNotification({ title, body, subtitle: sessionTitle, silent: severity !== "critical" })`；
   - 把 `{ kind, eventId, sessionId, runId, at }` 记到内存里的最近通知队列（给降级路径用）。
3. 点击回调（P1）：
   - `kind === "approval" || kind === "question"` → 打开待处理窗口，focus 到 `eventId`；
   - `kind === "completed" || kind === "error" || kind === "canceled"` → 打开会话详情，focus 到 `sessionId`；
   - 其它 → 打开设置/Agent 面板。
4. 托盘菜单增加「桌面通知」开关（写配置 + 重启服务或热更新）。
5. 退出时清理已投递通知（可选，减少「退出后点击找不到目标」的困惑）。

### 4.3 点击目标与窗口

| 通知 kind | 点击后 |
|---|---|
| `approval` / `question` | 新增「待处理」窗口，定位到具体 eventId |
| `completed` | 会话详情窗口，定位到 sessionId |
| `error` / `canceled` | 会话详情窗口，定位到 sessionId |
| `attention`（hook notice） | 有 sessionId 开会话详情，否则开设置/Agent 面板 |

现有 `app/web/app.js` 只处理 `mo-agent://pair`（`:939`），没有 session/approval 深链。需要新增 query 解析（或在桌面壳里直接 `executeJavascript` 选中会话/滚动到待办）。**这是「对应窗口」的主要产品工作量。**

## 5. 工作量估算

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | host `/local/events` + 桌面订阅 + `Utils.showNotification` + 托盘开关 + 权限验证 | **1–1.5 人日** |
| P0.5 | 点击降级：监听 `reopen`，打开最近一条/通知中心 | +0.5 人日 |
| P1 | 原生 delegate 点击回调 + userInfo target + 点击队列 | +2–4 人日 |
| P1.5 | 「待处理」窗口 + 会话详情深链 + 本机令牌页面 | +1–2 人日 |
| P2 | 与 HMS 去重/策略、权限引导、退出清理、错误恢复 | +1 人日 |
| 合计 | 基础可用（显示 + 激活面板） | **1.5–2 人日** |
| 合计 | 完整「点击打开对应窗口」 | **5–8 人日** |

## 6. 阻点与风险

| # | 阻点 | 影响 | 缓解 |
|---|---|---|---|
| 1 | Electrobun 内置通知无点击回调 / userInfo / id | 无法知道点的是哪条 | 自建原生 delegate（FFI 或 Swift helper） |
| 2 | 桌面没有审批/会话窗口 | 点击没有落点 | 新增「待处理」窗口 + 深链 |
| 3 | `/api/events` 需要设备令牌，桌面只有本机令牌 | 桌面收不到 notify | 新增 `/local/events`（推荐）或本机换取设备令牌 |
| 4 | 与手机 HMS 重复通知 | 同一件事弹两次 | 配置开关/优先级；默认需产品拍板 |
| 5 | ad-hoc 签名 + 重建可能重置通知权限 | 用户升级后收不到 | 首次启用引导去系统设置；构建后实测 |
| 6 | App 未运行时点击，delegate 设置晚于启动完成 | 点击 payload 可能丢 | 保持托盘常驻；退出时清理通知；或做登录项/helper |
| 7 | LSUIElement（无 Dock）点击激活后不一定有窗口 | 用户点了没反应 | 点击回调里显式 `show()` + `activate()` |
| 8 | 原生 FFI block completion / ObjC 调用约定 | 实现脆弱 | 先 spike；或改 Swift helper |
| 9 | Swift helper 独立 bundle id | 通知归属/点击启动对象不对 | 尽量主进程 FFI；helper 只负责回调 |
| 10 | 仅 macOS 验证 | Windows/Linux 行为不同 | 本期明确只做 macOS |

## 7. 建议的 1 天 Spike

目标：只回答三个问题，不写产品代码。

1. **能否显示**：托盘加一个临时「通知测试」菜单，调用 `Utils.showNotification({ title: "mo-agent 测试", body: "点我试试" })`，重新构建 ad-hoc 签名 .app。
   - 观察：是否弹权限、是否显示、重建后权限是否还在。
2. **点击有没有事件**：在桌面主进程里同时打日志监听 `app.on("reopen")` 和 `app.on("open-url")`。
   - 点通知，观察是否触发、触发的是哪个、是否能把 App 窗口带到前台。
3. **能否拿到 payload**：用一个最小原生 delegate（优先 `NSUserNotificationCenter`，因为它没有 completion block；或 Swift helper）给通知带 `userInfo={target:"approval:123"}`，点击后打印。
   - 分别测试「App 正在托盘运行」和「App 已退出后点击」两种情况。

验收标准：

- 能稳定显示通知，权限可引导；
- 点击能拿到 target（至少 App 运行时可）；
- 点击后能创建/显示一个 BrowserWindow 并置顶。

如果第 3 步在「App 未运行」场景失败，就把 P1 范围限定为「托盘运行时精确跳转；退出后只启动 App」，并在产品文案里说清楚。

## 8. 待拍板的问题

1. **桌面通知和手机 HMS 是否同时发？** 默认建议：桌面 App 运行时只发桌面，手机 App 离线时发手机；但 host 目前不知道桌面在线，需要定策略。
2. **完成类通知要不要点开会话详情？** 还是只开「设置」或「日志」？
3. **点击后是新建窗口，还是复用现有 panel 窗口？** 建议复用 panel 容器，但按 target 切页面，避免窗口越开越多。
4. **通知权限被拒时怎么办？** 托盘菜单提示 + 打开系统设置，还是静默降级？
5. **是否接受「退出 App 后点击只能启动，不能定位」？** 如果不可接受，需要登录项/独立 helper，成本再 +2–3 人日。

## 9. 验证命令（复现本文结论）

```bash
# 1. Electrobun 公开 API 只有 title/body/subtitle/silent
sed -n '66,122p' desktop/.hutch/devkit/api/sdks/main/core/Utils.ts

# 2. App 事件没有 notification-clicked
cat desktop/.hutch/devkit/api/sdks/main/events/ApplicationEvents.ts

# 3. 已安装原生库里的通知符号与 AppDelegate 方法
nm -gU /Applications/mo-agent.app/Contents/MacOS/libNativeWrapper.dylib | grep -i notif
otool -oV /Applications/mo-agent.app/Contents/MacOS/libNativeWrapper.dylib | grep -A20 'name .*AppDelegate'

# 4. host 通知出口与认证边界
sed -n '25,85p' core/notify.mjs
sed -n '437,450p' host/http.mjs
sed -n '386,390p' host/http.mjs
```
