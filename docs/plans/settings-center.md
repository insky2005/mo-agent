# 设置中心方案：监控屏入口与五类设置合并

状态：**已实现**　日期：2026-10-26
适用：mo-agent 0.2.x · macOS 桌面端（语音能力仍为 macOS）

## 0. 结论先行

1. 新增统一路由 `/settings?tab=...`，左侧固定五项：**App 安装与配对 / 钉钉机器人 / Agent 配置 / 语音 / 重启与日志**；右侧复用现有设置能力，不重写第二套逻辑。
2. 设置页仍由 host 服务端渲染，沿用「回环地址 + 本机令牌 + HttpOnly Cookie」鉴权；`/setup`、`/setup/dingtalk`、`/agents`、`/logs` 全部保留，避免破坏现有书签、测试和托盘入口。
3. 监控屏顶部新增「设置」按钮：在桌面 App 内通过 `host-message` 打开独立设置窗口；在普通浏览器里退化为同页跳转 `/settings?tab=app`。
4. 语音和重启依赖桌面壳能力（浮层、权限设置、重启 host），新增一层 **host-message 请求/应答桥**；语音启停通过本机令牌保护的 `/local/voice/reload` 动态重载，不再重启 host，监控屏也不会因此关闭。
5. 语音浮层增加持久化开关（`~/.mo-agent/voice.json` 的 `overlay` 字段），解决「设置窗口打开时浮层被强制收起」和「开关看起来不生效」的语义冲突。
6. 「重启与日志」同一个 tab：上方重启操作，下方直接复用日志查看器；重启成功后回到该 tab，日志里能看到新的启动横幅。

本文记录交互、改动面、接口与验收标准；对应实现已落地，具体行号以当前仓库为准。

## 1. 目标与非目标

### 目标

- 监控屏上有一个明确的「设置」入口，不需要再回菜单栏找。
- 一个设置窗口里完成五类设置，左侧切换，右侧不跳走、不重复开窗。
- 现有功能全部保留：配对二维码、钉钉扫码创建/绑定、Agent hook 一键配置、语音命令/口述/测试、重启、日志。
- 旧路由继续可用；托盘快速入口可逐步改为指向新 tab，不强制一次清理。
- 安全边界不退化：设置页、语音控制、重启操作都只允许电脑本机。

### 非目标

- 不改配对协议、钉钉 Stream 协议、Agent hook 写入格式。
- 不做设置项搜索、权限分级、多语言、云同步。
- 不做移动端设置页；手机端仍只负责配对、审批、语音结果展示。
- 不引入 React/Vue 等前端框架；继续用服务端 HTML + 原生 JS。
- 不做语音跨平台；语音 tab 在非 macOS 上显示不可用说明。
- 不做自动更新、版本管理、远程设置。

## 2. 现状盘点

| 能力 | 现状入口 | 关键实现 | 现状问题 |
|---|---|---|---|
| App 安装与配对 | 托盘「设置 → App 安装与配对」→ `/setup` | `host/pair-http.mjs:348-374` | 整页独立，页面自带 h1/sub，无法嵌进统一外壳 |
| 钉钉机器人 | 托盘「设置 → 钉钉机器人绑定」→ `/setup/dingtalk` | `host/pair-http.mjs:377-644` | 整页独立；关闭窗口时取消扫码轮询，切 tab 也要处理 |
| Agent 配置 | 托盘「一键配置 Agent…」→ `/agents` | `host/pair-http.mjs:735-800` | 整页独立；表单 303 固定回 `/agents` |
| 语音 | 托盘「语音」子菜单 +「显示/隐藏语音浮层」 | `desktop/src/bun/index.ts:648-685`、`696-719`、`1011-1044`、`1332-1563` | 没有设置页；开关写 `~/.mo-agent/voice.json`；原先切换启用状态要重启 host（现已改为动态重载） |
| 重启服务 | 托盘「重启服务」 | `desktop/src/bun/index.ts:542-584` | 重启后固定打开默认设置面板，不能停留在原页面 |
| 日志 | 托盘「查看日志」→ `/logs` | `host/logs-http.mjs:112-179` | 独立窗口，和重启操作分离 |
| 监控屏 | 顶部只有 时钟 / 连接状态 / 暂停 | `app/web/monitor.html:32-40`、`app/web/monitor.js:1184-1195` | 没有设置入口 |

补充现状：

- 设置窗口由 `desktop/src/bun/index.ts:380-442` 的 `createPanel()` 创建，固定 760×760，只处理 `panel-close` 一种 host-message；同一时间只保留一个 panel，打开新页面会销毁旧的。
- 所有管理页的鉴权在 `host/admin-auth.mjs:49-69`：回环地址 + 本机令牌（query/header）换 HttpOnly Cookie。
- 语音浮层在设置窗口打开时被 `syncVoiceOverlay()` 强制收起（`desktop/src/bun/index.ts:1019-1027`），关闭设置后才恢复；当前没有「用户想不想显示浮层」的持久化偏好。
- 语音启用开关原先由桌面壳写文件后调用 `restartService(false)` 重启 host（`desktop/src/bun/index.ts:696-703`），重启会关闭设置窗口；实现改为 host 内动态重载语音运行时。

## 3. 交互方案

### 3.1 监控屏入口

在监控屏顶栏右侧、时钟与「暂停」之间增加一个「设置」按钮：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ mo-agent 实时监控            21:08:32  服务 2h   ● 已连接   [设置] [暂停] │
└──────────────────────────────────────────────────────────────────────┘
```

行为：

1. 桌面 App 内：`window.__electrobunSendToHost({ type: "open-settings", tab: "app" })`，由桌面壳打开独立设置窗口。
2. 普通浏览器内（没有 `__electrobunSendToHost`）：`location.assign("/settings?tab=app")`，依赖浏览器里已有的管理 Cookie。
3. 设置窗口已经打开时再次点击：复用 `openPanel()` 的「先销毁旧 panel，再按目标 tab 重建」逻辑，保证落在正确 tab。
4. 设置窗口打开不关闭监控屏，两个窗口可以并排；设置窗口关闭后监控屏保持原样。
5. 快捷键不新增；`Esc` 仍然只关闭当前窗口。

实现位置：

- `app/web/monitor.html`：在 `.topRight` 里加 `<button class="ghost" id="btnSettings" type="button">设置</button>`。
- `app/web/monitor.js`：`dom.btnSettings` 绑定点击，优先走桌面桥，失败再跳转。
- `desktop/src/bun/index.ts`：`createMonitorWindow()` 的 host-message 分支增加 `open-settings`。

### 3.2 设置页面布局

```text
┌────────────────────────────────────────────────────────────────────┐
│  mo-agent · 设置                                         [原生关闭] │
├──────────────────┬─────────────────────────────────────────────────┤
│  App 安装与配对   │  App 安装与配对                                 │
│  钉钉机器人       │                                                 │
│  Agent 配置       │   ┌──────────────┐  ┌──────────────┐            │
│  语音             │   │  第 1 步 装 App │  │  第 2 步 配对  │            │
│  重启与日志       │   │    [二维码]    │  │    [二维码]    │            │
│                  │   └──────────────┘  └──────────────┘            │
│                  │   配对码 123456 · 换一个配对码                    │
└──────────────────┴─────────────────────────────────────────────────┘
```

- 左侧导航固定宽度约 220px，右侧内容区独立滚动。
- 窗口默认 **1040×800**，最小约 900×680；屏幕放不下时按工作区收缩。
- 窄窗口（< 760px）下左侧导航变成顶部横向可滚动 tab，避免挤压内容。
- 沿用现有深色配色：背景 `#0b1020`、卡片 `#141b32`、边框 `#263054`、主色 `#4f8cff`、成功 `#35d39a`。
- 每个 tab 使用整页导航（点击左侧 `<a>` 重新加载 `/settings?tab=...`），不做前端路由。理由：现有页面全是服务端生成 + 独立脚本，整页切换最简单、刷新后状态可恢复、无前端依赖。
- 右侧内容顶部显示当前 tab 标题和一句说明；左下角可显示 `mo-agent v0.2.0`（非必需）。

### 3.3 五个 tab 的内容与行为

#### 3.3.1 App 安装与配对（`tab=app`）

复用现有 `/setup` 的两张卡片：

- 第 1 步「装 App」：安装 APK 二维码、安装包版本/大小。
- 第 2 步「配对」：配对二维码、6 位配对码、有效期倒计时、换一个配对码。
- 底部网卡切换按钮、提示文案。
- 二维码图片仍然走 `/setup/qr/install.svg` 和 `/setup/qr/pair.svg`。

需要适配：

- 网卡切换链接从 `/setup?ip=...` 改为 `/settings?tab=app&ip=...`。
- 「换一个配对码」链接改为 `/setup/renew?next=/settings?tab=app`，`/setup/renew` 只接受白名单 `next`（`/setup` 或 `/settings?tab=app`），防止开放重定向。
- 配对成功时：
  - 旧行为：页面发 `panel-close` 关闭设置窗口。
  - 新行为：在设置中心内**不关闭整个窗口**，显示「✓ 配对成功」并 1.5 秒后刷新当前 tab，方便继续看其它设置；只有独立访问 `/setup` 时才保留自动关闭。
- 页面仍然每 1.5 秒轮询 `/setup/status`，过期自动刷新二维码。

#### 3.3.2 钉钉机器人（`tab=dingtalk`）

复用现有 `/setup/dingtalk` 的两张卡片：

- 第 1 步「创建机器人」：扫码创建、二维码有效期、进度、失败诊断、手动填写 Client ID / Client Secret / robotCode。
- 第 2 步「配对」：6 位配对码、绑定账号、钉钉连接状态、重新生成、解绑并清除配置。
- 已绑定状态卡片。
- 操作说明和常见问题（设置中心内建议收进 `<details>`，减少首屏长度，但内容不删）。

需要适配：

- 顶部自己的 `<h1>钉钉机器人绑定</h1>` 和副标题移除，由设置外壳提供。
- 离开 tab / 关闭窗口时取消 device-code 轮询：
  - 页面增加 `pagehide` 监听，用 `fetch(..., { method:"POST", headers:{"x-mo-agent-local":"1"}, keepalive:true })` 调 `/setup/dingtalk/onboard/cancel`；
  - 桌面壳关闭 panel 时也取消（不依赖 URL 精确匹配）。
- 原有 2 秒轮询、自动开始扫码、绑定成功后停止轮询的逻辑保持不变。

#### 3.3.3 Agent 配置（`tab=agents`）

复用现有 `/agents` 的列表：

- 顶部总进度「已配置 X / Y」和「一键配置全部 / 全部重新写入」。
- 每个 Agent 一行：名称、ID、状态徽标、配置文件路径、将写入的 hook 列表、实际命令详情、一键配置/更新/移除按钮。
- 原生接入的 Agent 显示方式说明。
- 成功/失败 banner。

需要适配：

- 顶部自己的 `<h1>一键配置</h1>` 和副标题移除，由设置外壳提供。
- 表单增加隐藏字段 `next`：
  - 设置中心内：`/settings?tab=agents`
  - 独立页面：`/agents`
- `POST /setup/hooks/apply` 读取 `next`，只接受上述两个白名单值，303 回对应地址并带上 `msg`/`bad` 参数；不传时保持原行为回 `/agents`。
- 其余 CSRF、备份、写配置逻辑完全不动。
- `/agents` 独立路由继续保留。

#### 3.3.4 语音（`tab=voice`）

这是唯一需要新做页面的 tab。内容分四块：

1. **语音开关**
   - 显示当前是否启用（读 `~/.mo-agent/voice.json`）。
   - 开关文案：「启用语音」（说明：开启后支持语音命令、口述、语音审批；切换会重新加载语音组件，约 1–3 秒，不重启服务）。
   - 未启用时，下方操作按钮置灰。

2. **语音浮层**
   - 状态：已显示 / 已隐藏 / 语音未启用。
   - 开关：「显示语音浮层」。
   - 显示全局快捷键（例如 `⌘⇧Space`）；本期只展示，不支持页面内修改。
   - 说明：设置窗口打开时浮层会暂时收起；关闭设置后按此开关恢复。手动点「显示」时立即显示在设置窗口上方，方便确认效果。

3. **语音操作**
   - 「语音命令」：说一条命令，执行后浮层显示结果。
   - 「语音口述」：说一段内容，先成草稿，回读确认后发送。
   - 「语音测试」：走一次完整语音测试并显示结果。
   - 每个按钮带一句说明；执行中禁用按钮并显示「正在浮层里进行…」；失败时在页面内显示错误摘要，不依赖弹框。

4. **系统权限**
   - 「麦克风权限设置…」→ 打开 macOS 隐私与安全性 → 麦克风。
   - 「辅助功能权限设置…」→ 打开辅助功能。
   - 说明：需要授予权限后语音才能稳定工作。

浏览器直接打开 `/settings?tab=voice` 时：

- 没有桌面桥，显示 banner：「语音控制需要在桌面 App 内操作；当前仅展示说明。」
- 所有按钮禁用，不伪造成功状态。

与托盘菜单的对应关系：

| 原托盘项 | 设置中心位置 |
|---|---|
| 显示/隐藏语音浮层 | 语音 → 语音浮层开关 |
| 启用语音 | 语音 → 语音开关 |
| 麦克风权限设置… | 语音 → 系统权限 |
| 辅助功能权限设置… | 语音 → 系统权限 |
| 语音命令 | 语音 → 语音操作 |
| 语音口述 | 语音 → 语音操作 |
| 语音测试 | 语音 → 语音操作 |

#### 3.3.5 重启与日志（`tab=system`）

从上到下：

1. **重启本地服务**
   - 标题、一句说明：「重启会短暂断开监控、语音和手机推送，Agent 会话本身不受影响。」
   - 显示 host 端口、日志路径（只读）。
   - 按钮「重启本地服务」采用两步确认：第一次点击变成「再次点击确认重启」，4 秒内不点恢复；第二次点击发送重启请求。
   - 点击后页面显示「正在重启本地服务…」，窗口由桌面壳关闭并在 host 就绪后重新打开同一个 tab；重启前开着的监控屏也会一起恢复。

2. **日志**
   - 直接显示 host 日志尾部，不再跳 `/logs`。
   - 顶部小工具栏：路径、连接圆点、「刷新」「暂停/继续」。
   - 默认每 1.5 秒拉 `/logs/data?lines=400`；页面不可见（`document.hidden`）时暂停轮询。
   - 自动滚动只在用户已经在底部时生效；用户往上翻时不打断。
   - 401 时显示「本机鉴权失效，请从桌面 App 重新打开设置」，停止轮询。
   - 日志可能很大，继续只读尾部 256KB；ANSI 色码继续剥离。
   - `/logs` 独立页面保留，供托盘「查看日志」和旧书签使用；两处共用同一个渲染函数。

## 4. 技术方案

### 4.1 总体结构：服务端组合，不用 iframe

明确选择：**把现有页面拆成「内容片段 + 页面外壳」，由设置外壳组合**，而不是用 iframe 嵌旧页面。

不用 iframe 的原因：

- 旧页面自带 h1、副标题、Escape 逻辑和 `panel-close`，嵌进 iframe 会出现双层标题、焦点和 Esc 行为混乱。
- 日志需要占满剩余高度，iframe 高度自适应麻烦。
- iframe 内的 fetch / 表单重定向 / 二维码刷新都多一层上下文，排查成本高。
- 服务端片段复用更彻底：旧路由和新设置页共用同一份 HTML/脚本，不会出现两套逻辑。

目标结构：

```text
host/http.mjs
  └─ settingsHandler(req, res, url, ctx)   // 由 host/index.mjs 注入，避免循环依赖
       └─ host/settings-page.mjs
            ├─ settingsLayout({ active, title, content, script })   // 左侧导航 + 页头 + 样式
            ├─ renderSetupSection()       ← 从 pair-http.mjs 导出
            ├─ renderDingTalkSection()    ← 从 pair-http.mjs 导出
            ├─ renderAgentsSection()      ← 从 pair-http.mjs 导出
            ├─ renderVoiceSection()       ← 新写
            └─ renderSystemSection()      ← 重启卡片 + logs-http.mjs 的 renderLogViewer()
```

页面片段约定：

```js
// 每个 renderXxxSection 返回：
{
  title: "App 安装与配对",   // 可选，设置外壳用来显示内容区标题
  body: "<div>...</div>",     // 不含 <html>/<body>/<h1>
  script: "<script>...</script>" // 只包含该 tab 需要的脚本
}
```

旧路由的整页函数保留为薄包装：

```js
// pair-http.mjs
export function renderSetupSection(ctx, url, mode) { ... }
function renderSetupPage(res, ctx, url) {
  const section = renderSetupSection(ctx, url, "standalone");
  html(res, 200, legacyPage("mo-agent 设置", section));
}
```

这样 `/setup` 的输出可以保持和现在几乎一致，测试不需要大改。

### 4.2 路由与鉴权

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings?tab=<tab>` | 统一设置页；`tab` 为 `app` / `dingtalk` / `agents` / `voice` / `system`，缺省或非法值回 `app` |
| GET | `/setup` | 保留：旧版安装与配对整页 |
| GET | `/setup/dingtalk` | 保留：旧版钉钉整页 |
| GET | `/agents` | 保留：旧版 Agent 配置整页 |
| GET | `/logs`、`/logs/data` | 保留：独立日志页与数据接口 |
| GET | `/setup/status`、`/setup/qr/*` | 不变 |
| POST | `/setup/hooks/apply` | 增加白名单 `next`，默认仍回 `/agents` |
| POST | `/setup/renew` | 增加白名单 `next`，默认仍回 `/setup` |
| POST | `/setup/dingtalk/*` | 不变 |

鉴权顺序（与现有管理页一致）：

1. 非回环地址 → 403，页面提示「仅限电脑本机」。
2. 没有有效本机令牌（query / header / Cookie）→ 401，提示从菜单栏打开。
3. 通过后 `grantAdminCookie()`，页面内部链接和 fetch 复用 Cookie。
4. 响应头继续带 `cache-control: no-store`、`referrer-policy: no-referrer`、`x-frame-options: DENY`、`x-content-type-options: nosniff`。

路由注册方式：

- `host/http.mjs` 不直接 import `settings-page.mjs`（避免 `http → settings → pair-http → http` 循环）。
- 新增 `options.settingsHandler`，由 `host/index.mjs` 传入：
  ```js
  import { handleSettingsRoutes } from "./settings-page.mjs";
  createMoAgentServer({ ..., settingsHandler: handleSettingsRoutes });
  ```
- `http.mjs` 在 pairHandler 之后、日志/监控之前或之后调用 `settingsHandler`；路径不重叠，顺序不影响。

### 4.3 现有页面拆片段

#### pair-http.mjs

- 新增导出：
  - `renderSetupSection(ctx, url, mode)`：二维码卡片 + 配对码 + 网卡按钮 + 轮询脚本。
  - `renderDingTalkSection(ctx, mode)`：创建/配对卡片 + 已绑定卡片 + 说明 + 脚本。
  - `renderAgentsSection(ctx, url, mode)`：banner + 进度 + Agent 列表 + 脚本。
- `mode` 只影响三件事：
  1. 链接前缀（`/setup` 还是 `/settings?tab=app`）；
  2. 配对成功后是否关闭窗口；
  3. 是否输出页面级 h1/sub。
- 抽出 `STYLE` 为可导出的 `PAGE_STYLE`，设置外壳直接包含，保证卡片/按钮/表单样式一致。
- CSRF 常量 `HOOKS_CSRF` 保持不变；表单仍带隐藏字段。
- 现有 `handlePairRoutes` 的鉴权、二维码、钉钉 API、hooks 写入逻辑不动。

#### logs-http.mjs

- 新增导出 `renderLogViewer({ file, mode })`，返回 `{ body, script }`。
- `/logs` 整页用 `renderLogViewer({ mode:"standalone" })` 包装。
- 设置中心用 `renderLogViewer({ mode:"inline" })`，只输出 toolbar + `<pre>`，高度由外层容器控制。
- `readTail()`、`stripAnsi()`、鉴权、`/logs/data` 都不变。

#### 样式

- 设置外壳的 CSS 负责：整体 grid、左侧导航、内容滚动、tab 标题、语音/重启卡片、日志容器高度。
- 内容片段继续使用现有的 `.card`、`.panel`、`.agent`、`.btn`、`.banner` 等类名。
- 设置页需要包含 `PAGE_STYLE`，否则片段样式缺失；日志片段需要 `LOGS_STYLE`。
- 现有 `.grid` 的两张 320px 卡片在 780px 内容区能放下；如果实际窗口更窄，改成 `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`，避免横向滚动。

### 4.4 桌面桥：host-message 请求/应答

设置页运行在 Electrobun 的 WebView 里，可以调用 `window.__electrobunSendToHost`。现有 `createPanel()` 只处理 `panel-close`；扩展为允许白名单请求。

#### 消息格式

页面 → 桌面：

```js
window.__electrobunSendToHost({
  type: "settings-request",
  requestId: "req-1",       // 页面生成，用于匹配响应
  action: "voice-test",     // 白名单
  payload: {}               // 可选，按 action 定义
});
```

桌面 → 页面：

```js
window.__moSettingsReply({ requestId: "req-1", ok: true, data: { ... } });
```

桌面实现：

```ts
function replySettings(win: BrowserWindow, requestId: string, result: unknown): void {
  if (!requestId) return;
  const json = JSON.stringify(Object.assign({ requestId }, result))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const webview = win.webview as { executeJavascript?: (js: string) => void } | undefined;
  try {
    webview?.executeJavascript?.("window.__moSettingsReply&&window.__moSettingsReply(" + json + ");");
  } catch (error) {
    logLine("设置页回包失败: " + error);
  }
}
```

页面实现：

```js
(function () {
  var pending = new Map();
  var seq = 0;
  window.__moSettingsReply = function (reply) {
    var item = pending.get(reply && reply.requestId);
    if (!item) return;
    pending.delete(reply.requestId);
    if (reply.ok) item.resolve(reply.data || {});
    else item.reject(new Error(reply.error || "操作失败"));
  };
  function shell(action, payload, timeoutMs) {
    if (typeof window.__electrobunSendToHost !== "function") {
      return Promise.reject(new Error("desktop-bridge-unavailable"));
    }
    return new Promise(function (resolve, reject) {
      var requestId = "req-" + (++seq);
      var timer = setTimeout(function () {
        pending.delete(requestId);
        reject(new Error("timeout"));
      }, timeoutMs || 8000);
      pending.set(requestId, {
        resolve: function (data) { clearTimeout(timer); resolve(data); },
        reject: function (error) { clearTimeout(timer); reject(error); },
      });
      try {
        window.__electrobunSendToHost({
          type: "settings-request",
          requestId: requestId,
          action: action,
          payload: payload || {},
        });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }
  window.__moShell = { shell: shell };
})();
```

#### action 白名单

| action | payload | 桌面行为 | 回包 data |
|---|---|---|---|
| `state` | 无 | 读取语音配置、浮层偏好/可见性、快捷键、host 是否就绪 | `{ voiceEnabled, overlay: { preference, visible }, shortcut, hostReady, platform }` |
| `voice-enable` | `{ enabled: boolean }` | 合并写 `voice.json`，刷新托盘，调 `/local/voice/reload` 动态重载 | `{ enabled, ready, status }`（不重启，窗口不关） |
| `overlay` | `{ visible: boolean }` | 写浮层偏好；显示/隐藏浮层 | `{ visible }` |
| `mic-settings` | 无 | 打开系统麦克风权限设置 | `{ opened: true }` |
| `accessibility-settings` | 无 | 打开系统辅助功能设置 | `{ opened: true }` |
| `voice-command` | 无 | `runVoiceCommand()` | `{ ok, reply, heard }` |
| `dictate` | 无 | `runDictate()` | `{ ok, reply, draft, target }` |
| `voice-test` | 无 | `runVoiceTest()` | `{ ok, outcome, heard }` |
| `restart` | 无 | 先回包，再 `restartService({ reopenTab: "system" })` | `{ restarting: true }` |
| `open-log-folder` | 无（可选） | 打开日志目录 | `{ opened: true }` |

约束：

- 只接受上述 action；未知 action 回 `{ ok:false, error:"unknown-action" }`。
- `payload` 只取明确字段，不把页面传来的路径、命令、URL 拼进 `executeJavascript` 或 shell。
- `requestId` 只用于回包，不参与任何命令执行。
- 长操作（语音命令/口述/测试）超时给 200 秒；普通操作 8 秒；重启不等待回包完成。
- 页面同时只允许一个长操作，按钮置灰，避免重复点。

#### 兼容普通浏览器

- 页面加载后 1 秒内没有收到 `state` 回包，就判定桌面桥不可用：
  - 语音 tab 显示说明并禁用按钮；
  - 系统 tab 的重启按钮禁用，日志仍可看；
  - 其它 tab 不受影响。
- 不使用 `window.close()` 作为主要关闭手段；设置页 Esc 继续走现有的 `panel-close` 转发，普通浏览器里退化为刷新/无操作。

### 4.5 语音配置与浮层状态

#### 配置文件

继续使用 `~/.mo-agent/voice.json`，扩展为：

```json
{
  "enabled": true,
  "overlay": true
}
```

- `enabled`：是否启用语音，现有 host 和桌面壳都读这个字段。
- `overlay`：是否希望显示语音浮层；缺省视为 `true`，保持旧行为。
- 写文件时**合并**现有 JSON，不能像现在 `writeVoiceEnabled()` 一样整文件覆盖，否则会把 `overlay` 等未来字段丢掉。
- 建议文件权限 `0600`。

#### 显示/隐藏语义

明确的规则：

1. **偏好**决定「没有窗口挡住时，语音浮层是否应该出现」。
2. 打开设置窗口或监控屏时，浮层临时收起，但**不改偏好**。
3. 关闭设置/监控后，`syncVoiceOverlay()` 按偏好恢复。
4. 用户在语音 tab 点「显示语音浮层」时，即使设置窗口开着也立即显示（显式操作优先），并把偏好设为 `true`。
5. 用户点「隐藏」时，立即隐藏并把偏好设为 `false`。
6. 浮层右上角的 × 继续隐藏浮层，并把偏好设为 `false`，避免关闭设置后它又自己回来。
7. 语音命令/口述/测试需要浮层反馈，允许临时显示；不强制改偏好。

对应改动：

- `readVoiceEnabled()` / `writeVoiceEnabled()` 改为读写完整配置对象，新增 `readVoiceOverlayPreference()` / `writeVoiceConfig(patch)`。
- `syncVoiceOverlay()` 增加 `!readVoiceOverlayPreference()` 判断。
- `toggleVoiceOverlay()` 从「只翻转当前可见性」改为「写偏好 + 显示/隐藏」，并允许在 panel 打开时由设置页显式调用。
- `hideVoiceOverlay(persist?: boolean)` 区分临时收起（打开 panel/monitor、重启）与用户主动隐藏（写偏好）。
- 托盘菜单文案根据偏好和当前可见性显示「显示语音浮层 / 隐藏语音浮层」；设置窗口打开时不再把该项禁用，而是允许设置页操作。

#### 启用/停用语音

- 切换 `enabled` 后由 host 动态重建语音运行时，不再重启 host。
- 设置页发 `voice-enable` → 桌面写配置、刷新托盘，调用：

```text
POST /local/voice/reload   // x-mo-agent-local: <本机令牌>
```

- host 先停旧通道/helper，再按 `voice.json` 创建新运行时；返回 `{ ok, enabled, ready, status }`。
- 页面显示「正在重新加载语音组件…」，成功后刷新状态；无窗口关闭、无 token 失效。
- 如果语音组件不可用（缺模型/权限），`ready=false`，页面显示 `status` 并引导看日志。

#### 语音状态展示

- 设置页平时展示「配置是否启用」和「浮层是否可见」；切换语音时额外显示 host 返回的 `ready/status`，不伪造「语音通道已就绪」。
- 语音测试/命令的实际结果由 host 返回，页面显示结果摘要；完整细节仍在浮层和日志里。
- 非 macOS 平台显示「当前平台暂不支持语音」，按钮禁用（与跨平台方案一致）。

### 4.6 重启流程

现有 `restartService(openPanelAfter: boolean)` 会：

1. 关闭设置 panel、语音浮层/浮球、日志窗口、监控屏；
2. kill host，等 500ms，重新 `ensureHost()`；
3. 可选打开设置 panel；
4. 恢复语音浮层。

改造为：

```ts
type SettingsTab = "app" | "dingtalk" | "agents" | "voice" | "system";

async function restartService(options: {
  reopenTab?: SettingsTab | null;
} = {}): Promise<void> {
  // 原有清理逻辑不变
  // ensureHost() 成功后：
  if (options.reopenTab) await openPanel(settingsUrl(options.reopenTab));
  await syncVoiceOverlay();
  syncVoiceOrb();
}
```

调用方：

| 调用方 | reopenTab |
|---|---|
| 托盘「重启服务」 | `"app"`（保持现有「重启后打开设置」行为） |
| 设置 → 重启与日志 | `"system"` |
| 设置 → 语音启用/停用 | 不再重启；走 `/local/voice/reload` |
| 其它内部重启 | `null` |

注意：

- 本机 `localToken` 现在从 `~/.mo-agent/session.json` 复用，host 重启后书签与 Cookie 仍然有效；桌面仍会重建 panel，因为端口/window 生命周期由壳管理。
- 重启前开着的监控屏会在 host 就绪后一起恢复；设置窗口最后打开，保持在最前面。
- 重启前先把 `{restarting:true}` 回给页面；页面被销毁也没关系。
- 重启失败时不重开设置 panel，直接打开日志目录/日志窗口，避免用户看到空白页。

### 4.7 设置窗口与 panel 生命周期

`createPanel(url)` 调整：

- `PANEL_URL` 从 `BASE + "/setup"` 改为 `settingsUrl("app")`；旧 `/setup` 仍可直接访问。
- 标题：
  - `/settings` → `mo-agent · 设置`
  - `/agents` → 保留旧标题
  - `/setup/dingtalk` → 保留旧标题
- 窗口尺寸：
  - `/settings` → 1040×800（按工作区收缩）
  - 旧页面 → 保持 760×760，避免旧页面布局被拉宽
- host-message 处理：
  - `panel-close`：关闭窗口（保留）。
  - `settings-request`：进入 action 白名单。
  - `open-settings`：只由监控屏发来，打开对应 tab。
- close 事件：
  - 任何 panel 关闭都调用 `cancelDingTalkOnboard()`（幂等，避免切 tab 后遗留轮询）。
  - 关闭后 `syncVoiceOverlay()` 按偏好恢复浮层。
- `openPanel(url)` 保持「先销毁旧 panel，再创建新 panel」；从监控屏打开设置时不要关闭 monitor。

### 4.8 托盘入口调整（建议同步做）

不强制一次删掉旧菜单，但建议把所有设置类入口指向新 tab，避免同一个功能有两个长相不同的页面：

| 托盘项 | 新行为 |
|---|---|
| 设置 → App 安装与配对 | 打开 `/settings?tab=app` |
| 设置 → 钉钉机器人绑定 | 打开 `/settings?tab=dingtalk` |
| 一键配置 Agent… | 打开 `/settings?tab=agents` |
| 语音 → 语音设置…（新增） | 打开 `/settings?tab=voice` |
| 语音 → 其它项 | 保留快捷操作（启用、权限、命令、口述、测试） |
| 显示/隐藏语音浮层 | 保留，写偏好 |
| 重启服务 | 保留，重启后打开 `tab=app` |
| 查看日志 | 打开 `/settings?tab=system`（也可以暂时保留 `/logs`） |
| 打开监控屏 | 不变 |

如果希望托盘更简洁，可以把「设置 →」子菜单合并成一个「设置…」，其余快捷项保留；这不影响本期验收。

## 5. 改动清单

| 文件 | 改动 | 风险 |
|---|---|---|
| `host/settings-page.mjs` | 新增：设置布局、五个 tab、路由、鉴权、语音/系统内容 | 中 |
| `host/settings-page.test.mjs` | 新增：鉴权、tab、内容、链接测试 | 低 |
| `host/pair-http.mjs` | 拆出 `renderSetupSection` / `renderDingTalkSection` / `renderAgentsSection`；`next` 白名单；配对模式 | 中高（800 行文件） |
| `host/logs-http.mjs` | 拆出 `renderLogViewer`；整页改为包装 | 低 |
| `host/http.mjs` | 接收并调用 `options.settingsHandler` | 低 |
| `host/index.mjs` | import `handleSettingsRoutes` 并传入 | 低 |
| `desktop/src/bun/index.ts` | 设置窗口尺寸/标题、host-message 白名单、语音配置合并、浮层偏好、重启 reopenTab、托盘深链 | 中高 |
| `desktop/src/bun/settings-bridge.ts`（建议） | 抽出纯函数：tab 校验、回包脚本、语音配置解析 | 低 |
| `app/web/monitor.html` | 顶栏「设置」按钮 | 低 |
| `app/web/monitor.js` | 按钮绑定 + 桌面桥/浏览器降级 | 低 |
| `app/web/monitor.css` | 按钮间距/窄屏适配 | 低 |
| `docs/README.md` | plans 索引加本文 | 低 |
| `DEVELOPMENT.md` | 落地后更新菜单说明和接口速查 | 低 |

不改：`host/dingtalk-*`、`host/agent-hooks.mjs`、`approvals/`、`adapters/`、手机 App。

## 6. 接口与协议汇总

### 6.1 HTTP

新增：

```text
GET  /settings?tab=app|dingtalk|agents|voice|system
POST /local/voice/reload   // 本机令牌；动态启停语音
```

保留：

```text
GET  /setup
GET  /setup/dingtalk
GET  /setup/status
GET  /setup/qr/install.svg
GET  /setup/qr/pair.svg
GET  /setup/dingtalk/qr.svg
GET  /setup/dingtalk/status
POST /setup/dingtalk/onboard/start
POST /setup/dingtalk/onboard/cancel
POST /setup/dingtalk/manual
POST /setup/dingtalk/bind/start
POST /setup/dingtalk/bind/confirm
POST /setup/dingtalk/bind/reset
GET  /agents
POST /setup/hooks/apply
GET  /logs
GET  /logs/data
GET  /setup/renew
```

变化：

- `POST /setup/hooks/apply`：新增可选 `next`，白名单 `/agents`、`/settings?tab=agents`。
- `GET /setup/renew`：新增可选 `next`，白名单 `/setup`、`/settings?tab=app`。
- 语音启停新增本机令牌保护的 `POST /local/voice/reload`；重启仍走桌面桥。

### 6.2 桌面 host-message

```text
panel-close                          // 现有：关闭窗口
open-settings { tab }                // 监控屏 → 打开设置窗口
settings-request { requestId, action, payload }  // 设置页 → 桌面
settings-reply (executeJavascript)   // 桌面 → 设置页
```

### 6.3 配置文件

```json
// ~/.mo-agent/voice.json
{ "enabled": true, "overlay": true }
```

`overlay` 缺省 `true`；写文件必须 merge。

## 7. 异常与边界

| 场景 | 处理 |
|---|---|
| host 没起来 | 桌面打开日志目录；设置页显示「本地服务不可用」，语音/重启禁用 |
| 本机令牌失效（session.json 被删/手动更换） | 页面显示 401 提示；从桌面重新打开设置 |
| 桌面桥不可用（普通浏览器） | 语音 tab 只读说明，重启按钮禁用，日志/配对/Agent 仍可用 |
| 语音未启用 | 浮层/命令/口述/测试按钮置灰，提示先启用 |
| 语音权限未授予 | 页面显示权限入口；语音结果里保留 host 返回的权限错误 |
| 浮层创建失败 | 页面显示错误摘要；语音命令/口述/测试退回弹框（沿用现有逻辑） |
| 重启失败 | 不重开空白设置页；打开日志，保留错误线索 |
| 配对二维码过期 | 页面自动刷新；设置中心内不关闭窗口 |
| 钉钉扫码超时/失败 | 页面自动重试或显示诊断；离开 tab 取消轮询 |
| 日志 401 | 停止轮询并提示重新打开 |
| 同时点多个语音操作 | 页面只允许一个 in-flight；其余按钮禁用 |
| 窄屏/小屏 | 设置窗口按工作区收缩；侧栏变顶部 tab；内容区纵向滚动 |
| 用户切 tab 时语音还在执行 | 桌面操作继续，浮层继续显示；页面丢弃回包，不报错 |

## 8. 安全边界

- `/settings` 与现有管理页同等级：只允许回环地址 + 本机令牌；局域网/外网 403。
- 设置页内所有动态文本继续 `escapeHtml`；`tab`、`next`、`ip` 全部白名单/校验。
- `next` 只接受两个固定值，禁止开放重定向。
- 桌面桥 action 白名单，payload 只读明确字段；页面不能传路径/命令/任意 JS。
- 回包用 `JSON.stringify` + `executeJavascript`，转义 U+2028/U+2029；不拼 HTML。
- 设置页响应头保留 `x-frame-options: DENY`、`nosniff`、`no-referrer`，不允许被第三方页面嵌入。
- 不把本机 token 写进 HTML/链接；首次 query token 由 `adminUrl()` 附加，随后换 HttpOnly Cookie。
- `/local/voice/reload` 只接受本机令牌（`x-mo-agent-local`），且只做语音启停，不接受页面传入的任意配置。

## 9. 验收标准

- [ ] 监控屏顶栏有「设置」按钮，点击能打开设置窗口；浏览器里点击能跳到 `/settings?tab=app`。
- [ ] 设置页左侧固定五项，顺序为：App 安装与配对、钉钉机器人、Agent 配置、语音、重启与日志；当前项高亮。
- [ ] 五个 tab 都能通过 URL 直达、刷新后保持；非法 tab 回退到 app。
- [ ] App 安装与配对：二维码、配对码、倒计时、网卡切换、换码都可用；设置中心内配对成功后不关闭整个窗口。
- [ ] 钉钉机器人：扫码创建、手动填写、配对码、解绑都可用；切走 tab / 关闭窗口后不再轮询。
- [ ] Agent 配置：列表、状态、一键配置/移除都可用；操作后 303 回设置中心对应 tab 并显示 banner。
- [ ] 语音：启用/停用、浮层开关、快捷键展示、语音命令/口述/测试、麦克风/辅助功能权限入口都可用；切换启用不重启 host、不关闭窗口。
- [ ] 重启与日志：上方重启两步确认；下方日志自动刷新、暂停/继续、自动滚动；重启后回到 system tab，日志出现新启动记录。
- [ ] 普通浏览器打开 `/settings?tab=voice` 时显示「需要在桌面 App 内操作」，按钮禁用，不报错。
- [ ] 非回环地址访问 `/settings`、`/settings?tab=voice` 返回 403；无令牌返回 401。
- [ ] 旧路由 `/setup`、`/setup/dingtalk`、`/agents`、`/logs` 行为不变。
- [ ] 托盘入口按 §4.8 指向新 tab（至少 App/钉钉/Agent/语音设置/日志）。
- [ ] 设置窗口关闭后，语音浮层按偏好恢复；隐藏后不会自己回来。
- [ ] `npm run check`、`npm test` 通过；桌面壳单测通过。

## 10. 测试计划

### 10.1 自动化

新增 `host/settings-page.test.mjs`，复用 `pair-http.test.mjs` 的 fake req/res 模式：

1. `GET /settings`（带 token）→ 200，包含五个菜单文案、当前 app tab、二维码/配对码。
2. `GET /settings` 无 token → 401；非回环 → 403。
3. `GET /settings?tab=agents` → 包含 Agent 列表、`name="next" value="/settings?tab=agents"`。
4. `GET /settings?tab=voice` → 包含「启用语音」「显示语音浮层」「语音命令」「语音口述」「语音测试」「麦克风权限设置」。
5. `GET /settings?tab=system` → 包含「重启本地服务」、`/logs/data`、日志路径。
6. `GET /settings?tab=unknown` → 200，回退 app。
7. 断言 HTML 里不出现本机 token。
8. 设置页不返回 `X-Frame-Options` 以外的宽松头；检查 `no-store`。

扩展 `pair-http.test.mjs`：

- `/setup/hooks/apply` 带 `next=/settings?tab=agents` 时 303 到该地址并带 msg。
- 非法 `next` 回退 `/agents`。
- `/setup/renew?next=/settings?tab=app` 303 到设置页；非法 next 回 `/setup`。

扩展 `logs-http.test.mjs`：

- `renderLogViewer({ mode:"inline" })` 包含 `/logs/data`、不带完整 `<html>`。
- 原有 `/logs` 标题测试保持。

扩展 `monitor-http.test.mjs`：

- 读取 `app/web/monitor.html`，断言包含 `id="btnSettings"`。
- 读取 `monitor.js`，断言包含 `open-settings` 或 `/settings?tab=app`。

桌面侧（建议）：

- 抽出 `desktop/src/bun/settings-bridge.ts` 后，用 `bun test` 测：
  - tab 白名单；
  - 语音配置 merge / overlay 默认 true；
  - 回包脚本对 U+2028 的转义。

### 10.2 手工验收

1. 开发态启动 host + 桌面壳，打开监控屏，点「设置」。
2. 依次切换五个 tab，确认无横向滚动、无双层标题、Esc 能关窗。
3. App tab：切网卡、扫配对码；确认配对成功后设置窗口不关闭，二维码刷新。
4. 钉钉 tab：开始扫码后切到别的 tab，看 host 日志确认轮询已取消；再回来能重新开始。
5. Agent tab：对一个 Agent 执行「一键配置」，确认回到 agents tab 且 banner 正确。
6. Voice tab：启用语音 → 组件动态重载，页面状态更新，窗口不关闭；打开/关闭浮层；执行语音测试；打开麦克风/辅助功能设置。
7. System tab：点两次重启 → 窗口重新打开并停在 system tab；日志出现新的启动横幅；点暂停后日志不再滚动。
8. 托盘各入口逐个点，确认落在正确 tab。
9. 浏览器直接访问 `/settings?tab=voice`（带 token），确认只读提示；访问 `/logs` 仍正常。
10. 局域网另一台设备访问 `http://<本机IP>:7788/settings`，确认 403。

## 11. 实施顺序

### 第 1 步：host 侧外壳（可先在浏览器验收）

- 新增 `host/settings-page.mjs` + 测试。
- 拆出 `renderSetupSection` / `renderDingTalkSection` / `renderAgentsSection` / `renderLogViewer`。
- `http.mjs`/`index.mjs` 接 `settingsHandler`。
- 完成 app / dingtalk / agents / system 四个 tab。
- 保留旧路由，跑 `npm test`。

### 第 2 步：监控屏入口 + 桌面窗口

- monitor 顶栏按钮 + 桥/降级。
- `createPanel` 支持 `/settings` 尺寸、标题、tab 解析。
- `openPanel` 从监控屏打开设置。
- 托盘入口改深链（至少 app/dingtalk/agents/logs）。

### 第 3 步：语音桥与动态重载

- 语音配置 merge + overlay 偏好。
- `settings-request` 白名单 + 回包。
- voice tab 全部按钮。
- `restartService({ reopenTab })`。
- system tab 重启按钮。
- 处理重启/切 tab 的竞态。

### 第 4 步：回归与文档

- 全量单测 + 手工验收。
- 更新 `DEVELOPMENT.md` 菜单说明、接口速查。
- 更新 `docs/README.md` 索引（本文已加）。
- 视情况把 `docs/guides/voice.md` 的入口说明改为「菜单栏 → 设置 → 语音」。

## 12. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| `pair-http.mjs` 拆片段破坏旧页面 | 配对/钉钉/Agent 配置不可用 | 保留旧整页包装；先加测试再拆；新旧路由共用片段 |
| 设置窗口尺寸变化导致布局溢出 | 内容被截断 | 内容区独立滚动；卡片宽度改 `minmax`；1040×800 起步 |
| 语音动态重载失败 | 开关显示已启用但语音不可用 | 返回 `ready/status`，页面提示看日志；下次重载可恢复 |
| 钉钉轮询泄漏 | 后台一直请求钉钉 | `pagehide` + panel close 双保险；cancel 幂等 |
| 浮层偏好改动影响旧用户 | 隐藏后不再自动出现 | 默认 `overlay=true`；只有用户主动隐藏才写 `false` |
| 桌面桥回包注入 | XSS/命令注入 | action 白名单；JSON 转义；不拼 HTML/命令 |
| 重启后监控屏消失 | 用户需要手动再开 | 已实现：重启前开着监控屏时，host 就绪后自动恢复 |
| 旧路由与新页面行为不一致 | 书签/测试困惑 | 旧路由保留，但托盘统一指向新 tab；文档标注 |

回滚：

- 把托盘/监控屏入口改回旧 URL，`/settings` 即使保留也不影响主流程。
- `voice.json` 新增字段向后兼容，旧版本忽略 `overlay`。
- 不迁移数据、不改协议，回滚无需清理。

## 13. 已定默认与待确认

已按以下默认落地：

1. 设置窗口 1040×800，与监控屏并排，不强制关闭监控屏。
2. 设置中心内配对成功不自动关闭窗口；独立 `/setup` 保留自动关闭。
3. 语音浮层偏好持久化到 `voice.json.overlay`，默认 `true`。
4. 旧路由全部保留；托盘入口逐步改为新 tab。
5. 语音启停通过本机令牌保护的 `/local/voice/reload` 动态重载，不重启 host；重启仍走桌面桥。
6. 日志同时保留 `/logs` 独立页和设置内嵌视图，共用渲染函数。

后续可再确认（不影响当前可用性）：

- 托盘是否要把「设置 →」子菜单合并成单个「设置…」？本文建议保留快捷项，只改落点。
- 重启后恢复监控屏已实现；是否需要恢复更多窗口（如旧日志窗口）后续再看。
- 语音 tab 是否要展示 host 实际语音通道状态（需要新增只读接口）？本文建议先不展示，避免造一个不准确的「已就绪」。

## 14. 附录：关键代码位置

| 位置 | 内容 |
|---|---|
| `app/web/monitor.html:32-40` | 监控屏顶栏，设置按钮加在这里 |
| `app/web/monitor.js:1147-1211` | 监控屏事件绑定，设置按钮绑定放这里 |
| `desktop/src/bun/index.ts:17-22` | BASE / PANEL_URL / AGENTS_URL 等常量 |
| `desktop/src/bun/index.ts:380-442` | `createPanel` / `openPanel`，窗口尺寸与 host-message |
| `desktop/src/bun/index.ts:542-584` | `restartService` / `restartHost` |
| `desktop/src/bun/index.ts:648-685` | 托盘菜单 |
| `desktop/src/bun/index.ts:696-719` | 语音开关与权限设置 |
| `desktop/src/bun/index.ts:1011-1044` | 浮层同步与切换 |
| `desktop/src/bun/index.ts:1332-1439` | 浮层创建与显示 |
| `desktop/src/bun/index.ts:1441-1563` | 语音命令/口述/测试 |
| `desktop/src/bun/index.ts:1607-1633` | 托盘点击分发 |
| `host/http.mjs:236-278` | pair / logs / monitor 路由接入点 |
| `host/pair-http.mjs:196-223` | 管理页鉴权 |
| `host/pair-http.mjs:348-374` | 安装与配对页面 |
| `host/pair-http.mjs:377-644` | 钉钉路由与页面 |
| `host/pair-http.mjs:735-800` | Agent 配置页面 |
| `host/logs-http.mjs:34-68` | 日志尾部读取 |
| `host/logs-http.mjs:112-179` | 日志页面与路由 |
| `host/admin-auth.mjs:49-69` | 本机令牌 / Cookie 鉴权 |
