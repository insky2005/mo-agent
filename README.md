# mo-agent

观察这台电脑上**所有** Agent 的运行状态，在关键卡点（等待授权 / 等待回答）通知你的手机和耳机，并支持**在手机上批准或拒绝**。

> 定位：不改变你的工作方式。Agent 照旧在你的终端 / IDE 里跑，mo-agent 只是在旁边看着，并在卡点上叫你一声。

## 当前状态

| 模块 | 状态 |
|---|---|
| core/ 统一事件模型 + A2A 状态词表 + 事件缓冲 | 已完成 |
| adapters/dsh  DSH 数据源（观测 + 控制 + 问答） | 可用 |
| adapters/claude-code  Claude Code transcript 观测 | 可用 |
| adapters/process-scan  进程发现 | 可用 |
| approvals/ 远程批准中枢 + hook CLI | 已实现并端到端验证 |
| host/ 主程序（HTTP + SSE + 配对 + 二维码） | 可用 |
| app/web/ 手机端 PWA（扫码配对 / 授权卡片 / 语音） | 可用 |
| app/android/ Capacitor 原生外壳 + HMS Push | 已打包出 APK |
| core/notify.mjs 统一通知路由（分级 + 去重 + 通道） | 已实现 |
| host/notify-webhook.mjs 第三方通道（Bark/钉钉/企业微信/飞书/通用） | 已实现 |
| host/hms-push.mjs 华为 HMS 推送（OAuth + messages:send） | 已实现并验证送达 |
| desktop/ 桌面壳 | 已完成 |

## 快速开始

    npm install
    npm start

启动后终端会打印：手机访问地址、6 位配对码，以及一个终端二维码。

## 扫码配对

两条路：

1. 看终端：启动日志里直接有一个二维码，用手机 App 扫它。
2. 看配对页：在电脑浏览器打开 http://127.0.0.1:7788/pair ，页面显示二维码，并可切换网卡（手机连不上时多半是选错了网段）。

二维码里是一次性令牌：默认 5 分钟有效，兑换一次即作废，比长期不变的配对码安全。

手机侧优先用浏览器的 BarcodeDetector，退化到内置的 jsQR；两者都没有时提示手输配对码。

扫到的地址会以绝对基址存进 localStorage，因此 App 从 capacitor:// 加载时也能连回电脑。

## 启用远程批准（Claude Code）

1. 把 hooks/claude-code/settings.snippet.json 合并进 ~/.claude/settings.json，把 <ABSOLUTE_PATH> 换成本仓库的绝对路径。
2. 保持 mo-agent 在运行。
3. 在 Claude Code 里触发一个需要授权的操作：
   - 手机在线：手机弹出授权卡片，点「允许一次」后 Agent 继续；
   - 手机不在线 / 超时：hook 不输出任何内容并退出 0，你在终端里照常看到原来的授权提示。

这条「失败交回本地终端」是刻意设计，见 docs/adr/adr-0001-observational-first.md。

## 打包 Android App

前置：JDK 21、Android SDK。一条命令：

    ./scripts/build-android.sh

产物：app/android/app/build/outputs/apk/debug/app-debug.apk

装到手机：

    adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk

首次打开 App 没有服务地址，点「扫码配对」扫电脑上的二维码即可完成连接。

### 本机已做的三处适配

Capacitor 7 默认要 android-35，而本机 SDK 只有 34/36，且 SDK 目录不可写，因此做了：

1. app/android/variables.gradle：compileSdk / targetSdk 改到 36；
2. app/android/build.gradle：强制 kotlin-stdlib-jdk7/jdk8 到 1.8.22，消除重复类；
3. gradle.properties：加 android.suppressUnsupportedCompileSdk=36。

构建脚本另外把 GRADLE_USER_HOME 与 ANDROID_USER_HOME 指向工作区内，避免依赖家目录写权限。

## 桌面托盘（macOS）

    ./scripts/build-desktop.sh

产物：desktop/build/stable-macos-arm64/mo-agent.app（约 46MB，含单文件 host 运行时）

双击启动后菜单栏出现托盘图标，并默认弹出「设置（安装与配对）」面板；菜单项：

- 设置（安装与配对）：弹出面板窗口，里面就是「扫码装 App」和「扫码配对」两个二维码
- 重启服务：重启本地 host 服务，随后自动打开「设置」面板
- 查看日志：在面板窗口里实时查看 host 日志（仅本机可打开 /logs）
- 退出

托盘会自己把 host 服务拉起来（默认端口 7788），退出时一并结束。

### 运行时与升级

构建时会把 host 编译成单文件，并连同 app/web、adapters/profiles、HMS 默认配置一起打进 .app。
首次启动时安装/更新到：

    ~/Library/Application Support/mo-agent/runtime

- 升级 .app 后再次启动，会按 runtime.json 的版本号自动覆盖运行时；
- 用户数据（配置、设备令牌、push token）在 ~/.mo-agent，升级不会动；
- 因此分发包不再依赖本机仓库路径，也不需要用户安装 Node；
- 开发时设置 MO_AGENT_ROOT=<仓库路径> 可直接运行源码。

注意：host/notify-defaults.json 含 HMS App Secret，已加入 .gitignore；发布打包时必须随包提供。

## 扫码装 App + 扫码配对

电脑浏览器打开 http://127.0.0.1:7788/setup ，页面两步：

1. 第 1 步「装 App」：手机扫码下载 APK（需允许安装未知来源应用）；
2. 第 2 步「配对」：打开 App 后点「扫码配对」扫第二个码，自动完成连接。

APK 由 GET /app.apk 直接提供，来源是 app/android/app/build/outputs/apk/debug/app-debug.apk。
桌面 App 构建时会把该 APK（和 version.json）一起打进运行时，所以分发包里自带安装包；
更新 APK 后需要重新构建桌面 App，分发包里的安装包才会更新。
页面底部可切换网卡（手机连不上时多半是选错网段）。

## 锁屏通知（Android / HMS Push）

局域网是明文 HTTP，浏览器 PWA 拿不到 Service Worker / Notification，页面一关就收不到。
所以 Android 走**华为 HMS Push**（系统级推送）：

- AGC 应用（包名 cn.mocampus.moagent.android）开启 Push Kit，并登记 APK 的 SHA-256 签名指纹；
- App 配对后向 HMS 取 push token，经 /api/push-token 上报给 host；
- host 的 host/hms-push.mjs 用 App ID / App Secret 换 OAuth token，调用华为推送接口；
- 通知由系统直接展示：**App 被杀、锁屏、后台都能收到**，不依赖长连接，也不需要华为电池白名单；
- 首次启动 host 会自动生成 ~/.mo-agent/notify.json（内含 HMS 通道），无需手写。
- 需在 AGC 申请**自分类权益**（服务与通讯 → 工作事项提醒 WORK）。未申请时华为按营销类频控
  （非新闻类约 2 条/天），**接口仍返回 80000000，但通知会被静默丢弃**。
- 报文的 `category` 必须放在 **android.category**（与 android.notification 同级）；
  放进 notification 里会被华为忽略，自分类不生效。

旧的 SSE 前台服务已停用，「mo-agent 正在守候」常驻通知不再出现。

通知分级仍在 core/notify.mjs：授权 / 提问 / 失败 = critical，任务完成 = normal，同一件待办只提醒一次。

重新打包安装：

    ./scripts/build-android.sh
    adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk


## 通知通道（可选）

除了 Android 原生前台服务，host 还能把同一条 notify 事件转发到第三方 App，用来覆盖 iPhone 或跨网段。
配置文件默认是 ~/.mo-agent/notify.json（里面有 channels 数组），示例见 docs/notify.example.json：

    {
      "channels": [
        { "type": "bark", "url": "https://api.day.app/你的BarkKey" },
        { "type": "dingtalk", "url": "https://oapi.dingtalk.com/robot/send?access_token=xxx", "secret": "SECxxx" },
        { "type": "wecom", "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" }
      ]
    }

支持的类型：bark（iPhone）、dingtalk（钉钉）、wecom（企业微信）、feishu（飞书）、generic（把通知 JSON 原样 POST 出去）。
Bark 也可以写成 { "type": "bark", "deviceKey": "你的Key" }，走官方 /push 接口。

改完配置后重启服务生效（桌面托盘「重启服务」，或重跑 npm start）。
临时调试可以用环境变量 MO_AGENT_NOTIFY_WEBHOOKS（JSON 数组）。

## 目录结构

    core/          共享：事件模型、状态词表、事件缓冲（纯逻辑，无 IO）
    adapters/      观测适配层，每 Agent 一份 profile（adapters/profiles/*.json）
    approvals/     远程批准：broker + hook 命令行入口
    host/          主程序：HTTP / SSE / 配对 / 二维码 / 编排
    app/web/       手机端 PWA 源码
    app/android/   Capacitor 原生工程
    app/ios/       暂缓
    desktop/       桌面壳（Electrobun，待开始）
    hooks/         各 Agent 的 hook 安装模板
    docs/          adr/ 决策 · research/ 预研 · spec/ 规格
    scripts/       probe-dsh（探针）、inspect-sessions（会话排查看派生关系）、e2e-approval（回归）、build-android

## 架构

    L1 进程发现 ┐
    L2 会话日志 ├─► core/hub 统一事件模型 ─► host (HTTP+SSE) ─► app ─► 手机/耳机
    L3 hooks   ┤        (A2A 状态词表)
    L4 tmux    ┘

设计依据：docs/adr/adr-0001-observational-first.md（观察优先，暂不做 ACP 托管）。

## 会话派生关系（分支）

DSH 的会话列表里除了主干会话，还会列出**从主干派生出来的分支**（字段 parentSessionId）。
mo-agent 的处理：

- 手机端「只看活跃」默认**不显示非运行中的分支**（不跑的分支只是历史）；
- 分支在列表里打「分支」标签，meta 行标「分支自其它会话」；
- 分支**正在运行**时仍然显示——那确实是活跃的，你可能要控制它；
- 想看全部时取消「只看活跃」。

排查用：node scripts/inspect-sessions.mjs

自检：npm run check（语法）· npm test（host/logs-http 单测）

## 接口速查

    GET  /setup                设置页（装 App + 配对两个二维码；桌面面板打开的就是它）
    GET  /pair                 二维码配对页（公开）
    GET  /pair/qr.svg          二维码图片（公开，?ip= 可指定网卡）
    GET  /logs                 日志页（仅回环地址可访问；桌面「查看日志」打开）
    GET  /logs/data            日志尾部若干行 JSON（仅回环地址）
    POST /api/pair             配对：{pin} 或 {qrToken}
    GET  /api/state            全量快照（会话 + 待批准 + 进程）
    GET  /api/events           SSE 事件流（?since= 断点重放）
    POST /api/approve          手机决定：{id, decision}
    POST /local/approval       hook 回调（本机令牌）
    GET  /local/pair-payload   取当前二维码载荷（本机令牌，供桌面端渲染）

    SSE  event: notify         统一通知出口（授权/提问/完成/失败，带 severity）

## 菜单栏图标与 Dock 行为

- 菜单栏显示**单色模板图**，系统按亮暗主题自动反色。图标源：desktop/src/mainview/tray.png（36×36），由 scripts/gen-icons.mjs 生成。
- 应用图标：desktop/icon.iconset/ → 打包时转成 AppIcon.icns（mac.icons 默认就指向 icon.iconset）。
- **不占 Dock**：构建时往 Info.plist 写 LSUIElement=true，这一步**必须在 ad-hoc 重签之前**，否则会破坏签名；
  运行时再调一次 Utils.setDockIconVisible(false) 兜底（dev 模式没有 plist 那一层）。
- 重新生成图标：node scripts/gen-icons.mjs

注意：Electrobun 用 metadata.json 里的 hash 作为解压缓存键。换版本重建后 hash 会变，启动器会自动重新解压一次；
若想强制干净重来，删除 ~/Library/Application Support/dev.moagent.desktop 即可。


## 图标系统（Agent 机器人头）

字形只在 scripts/icon-art.mjs 定义一次，四端派生共用，保证观感一致：

| 输出 | 来源 | 说明 |
|---|---|---|
| macOS App 图标 | svgSquircle | 深色圆角方 + 彩色机器人头 → desktop/icon.iconset/ → AppIcon.icns |
| Android 传统图标 | svgSquircle / svgCircle | mipmap-*/ic_launcher(.round).png |
| Android 自适应前景 | svgForeground | 缩到 66/108 圆形安全区内；底色在 values/ic_launcher_background.xml |
| 桌面托盘 | traySvg("#000") | 单色剪影，眼睛/嘴用 mask 挖透明；macOS 模板图按 alpha 上色并随亮暗主题反色 |

托盘图特意比 App 图标更粗更大——实际渲染只有 18px，细节会糊。

    node scripts/gen-icons.mjs      # 重新生成全部图标
    node scripts/icon-preview.mjs   # 生成 docs/icon-preview.png（含深色底反色模拟与 18px 放大）
    ./scripts/build-desktop.sh && ./scripts/build-android.sh

改图标只改 scripts/icon-art.mjs；改完两端都要重新打包。
