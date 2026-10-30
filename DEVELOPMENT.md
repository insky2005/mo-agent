# mo-agent 开发文档

> 产品介绍与快速上手见 [README.md](README.md)。本文保留安装、Agent 接入、构建、接口、架构与排障说明。

观察这台电脑上**所有** Agent 的运行状态，在关键卡点（等待授权 / 等待回答）通知你的手机和耳机，并支持**在手机上批准或拒绝**。

> 定位：不改变你的工作方式。Agent 照旧在你的终端 / IDE 里跑，mo-agent 只是在旁边看着，并在卡点上叫你一声。

## 当前状态

| 模块 | 状态 |
|---|---|
| core/ 统一事件模型 + A2A 状态词表 + 事件缓冲 | 已完成 |
| core/contract.mjs 规范事件 + 通知策略表 + 契约测试 | M1–M4 已落地（见 docs/spec/event-contract.md） |
| 会话来源标识 + 控制能力门控 | 已落地（手机卡片显示 Agent；Claude / Qoder CN / WorkBuddy 只读） |
| 会话详情 / 历史轮次 | 已落地（点「查看完整」查看前几轮） |
| adapters/dsh  DSH 数据源（观测 + 控制 + 问答） | 可用 |
| adapters/claude-code  Claude Code transcript 观测 | 可用（只读；手机不能发指令） |
| adapters/qoder-cn  Qoder CN 桌面端（智能工作台）观测 | 可用（transcript + hook；手机不能发指令） |
| adapters/workbuddy  WorkBuddy 桌面端（genie transcript + hook）观测 | 可用（观测 + hook 配置；放行待真机验证） |
| adapters/process-scan  进程发现 | 可用 |
| approvals/ 远程批准中枢 + hook CLI | 已实现并端到端验证 |
| host/agent-hooks.mjs Agent hooks 配置管理（一键配置 / 备份 / 卸载） | 已实现（Claude Code、Qoder CN、WorkBuddy；托盘「一键配置 Agent…」/ /agents / npm run hooks） |
| host/ 主程序（HTTP + SSE + 配对 + 二维码） | 可用 |
| app/web/ 手机端 PWA（扫码配对 / 授权卡片 / 语音） | 可用 |
| app/android/ Capacitor 原生外壳 + HMS Push | 已打包出 APK |
| core/notify.mjs 统一通知路由（分级 + 去重 + 通道） | 已实现 |
| host/notify-webhook.mjs 第三方通道（Bark/钉钉/企业微信/飞书/通用） | 已实现 |
| host/hms-push.mjs 华为 HMS 推送（OAuth + messages:send） | 已实现并验证送达 |
| desktop/ 桌面壳（含日志轮转、语音开关） | 已完成 |
| host/voice/ 两段式语音确认（TTS 播报 + 口令 + 草稿回读） | 已并入桌面分发包（默认关闭，托盘可勾选）；手册见 docs/guides/voice.md，正式签名/升级验证暂缓 |

## 快速开始

    npm install
    npm start

启动后终端会打印：手机访问地址、6 位配对码，以及一个终端二维码。

## 生成物与提交规则

仓库里有两个文件**由代码生成、必须和源一起提交**：

| 生成物 | 源 | 生成命令 |
|---|---|---|
| `skills/mo/SKILL.md` | `core/manager/contract.mjs` | `npm run gen:skill` |
| `cli/lib/skill-content.mjs` | 同上（内联副本，给单文件二进制用） | 同上 |

规则：

- 改了 `core/manager/contract.mjs`（工具表、流程、铁律、失败文案）→ 跑 `npm run gen:skill`，把两个产物一起提交；
- **不要手改** `skills/mo/SKILL.md`，下次生成会覆盖；
- `npm test` 和 `npm run check` 都会校验是否过期，过期直接失败（CI 也会拦）；
- `scripts/build-cli.sh` 只校验不生成——构建不该悄悄改工作区。

同类规则也适用于 `docs/reference/capabilities.md`（`npm run docs:capabilities`）。

## CI 与发版

### 流水线

| workflow | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push `main` 或 `feat/**` / PR / 手动 | ubuntu + macOS × Node 20/22：`npm ci → npm run check → npm test`；Windows 先只记基线（`continue-on-error`） |
| `cli-release.yml` | push tag `cli-v*` / 手动指定 tag | 版本一致性 → 测试 → 5 个平台**原生**构建 → 冒烟 → 产物扫描 → 发 Release + SHA256 + 构建来源证明 |
| `apk-release.yml` | push tag `apk-v*` / 手动 | 版本取自 tag → 签名（secrets）→ 构建 APK → 扫描 → 发 Release |
| `desktop-release.yml` | push tag `desktop-v*` / 手动 | macOS arm64 + x64 原生构建（默认不带语音）→ 扫描 → 发 Release |

### 只验证构建（dry run）

不想发版、只想确认五个平台都能构建时，手动触发并保持 `dry_run` 勾选：

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/insky2005/mo-agent/actions/workflows/cli-release.yml/dispatches \
  -d '{"ref":"feat/cli-cross-platform","inputs":{"tag":"cli-v0.2.0","dry_run":"true"}}'
```

或在 Actions 页面点「Run workflow」。dry run 会跑完 verify + 5 个平台的构建与冒烟，
产物作为 artifact 可下载，但**不会建 tag、不会发 Release**。

### 标签约定

| 组件 | tag | 触发 | 产物 |
|---|---|---|---|
| CLI | `cli-v0.2.0` | `cli-release.yml` | `mo-{darwin,linux}-{arm64,x64}`、`mo-windows-x64.exe` |
| APK | `apk-v0.2.0` | `apk-release.yml` | `mo-agent-android-0.2.0.apk` |
| Desktop | `desktop-v0.2.0` | `desktop-release.yml` | `mo-agent-desktop-<ver>-macos-{arm64,x64}.zip` |

三个组件各自独立发版，**顺序无所谓**：安装脚本不再用 `releases/latest`，
而是从新到旧找第一个真的带目标资产的 release。

```bash
git tag cli-v0.2.0 && git push origin cli-v0.2.0   # 只发 CLI
git tag apk-v0.2.0 && git push origin apk-v0.2.0   # 只发 APK
```

### 发版步骤

1. 同时改 `package.json` 和 `cli/lib/version.mjs` 的版本（`npm run cli:version:check` 校验两者一致）；
2. 提交后打 tag 并推送：`git tag cli-v0.2.0 && git push origin cli-v0.2.0`；
3. Release 里会有 `mo-darwin-arm64`、`mo-darwin-x64`、`mo-linux-x64`、`mo-linux-arm64`、`mo-windows-x64.exe`，以及各自的 `.sha256` 和合并的 `SHA256SUMS`；
4. 用户侧用 `installer/get-cli.sh`（macOS/Linux）或 `installer/get-cli.ps1`（Windows）安装。
   CI 里的 `create-release` 会按资产解析，不需要 `releases/latest`。

### APK 单独发

```bash
git tag apk-v0.2.0 && git push origin apk-v0.2.0
```

- 在 ubuntu runner 上构建，**不带 `agconnect-services.json`**（workflow 里有断言，出现就失败），
  所以 APK 没有 HMS 推送能力，也不含 AGC 凭据；
- 签名材料走 GitHub Secrets，仓库里不放 keystore：
  `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`。
  本地构建放 `app/android/app/keystore.properties`（已 gitignore），没有就退回仓库里的 debug key；
- 产物名 `mo-agent-android-<version>.apk`，versionCode 由 tag 推导（`0.2.0` → 200）；
- 装到手机：`bash scripts/fetch-apk.sh` 把最新 APK 下到 `~/.mo-agent/app.apk`，
  host 的 `/app.apk` 会优先用打包进运行时的那份，没有就用这份，手机扫码即可安装；
  `curl ... | bash -s -- --with-apk` 装 CLI 时也能顺带下载。

生成一把新 keystore（换签名会让已装 App 必须卸载重装）：

```bash
# 项目内放（Gradle 默认就找这个位置；两个文件都已 gitignore）
mkdir -p app/android/app/keystore
keytool -genkeypair -keystore app/android/app/keystore/release.jks -alias moagent \
  -keyalg RSA -keysize 2048 -validity 10000

cat > app/android/app/keystore.properties <<'EOF'
storeFile=keystore/release.jks
storePassword=你的store密码
keyAlias=moagent
keyPassword=你的key密码
EOF

base64 -i app/android/app/keystore/release.jks | pbcopy   # 粘进 GitHub Secret
```

> 放项目里也行：`.gitignore` 已覆盖 `*.jks` / `keystore.properties` / `app/android/app/keystore/release.*`，
> 并且 `npm run check` 会检查这些文件**是否被 git 跟踪**，误提交会直接失败。
> 但请另外**离线备份**一份——keystore 丢了就没法再给已安装用户发更新。

### Desktop 单独发

```bash
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```

- 矩阵：只有 `macos-14`（arm64）。**Electrobun 没有 macOS x64 的运行时**，Intel 机器会报
  `hutch: could not resolve Hutch: ReleasePlatformMissing`；CLI 的 `mo-darwin-x64` 不受影响。
- 默认 `WITH_VOICE=0`（约 46MB），需要语音就在手动触发时勾上（会现下 252MB 模型）；
- 构建前会尝试 `fetch-apk.sh`，拿到 APK 就一起打进分发版，setup 页可直接扫码安装；
- 分发产物一律 `MO_AGENT_DESKTOP_HMS=0`，不带 HMS 凭据；
- 发布前 `check-artifacts --enforce` 会递归解开 zip → .tar.zst → runtime.tar.gz 检查。

### 注意

- 每个平台都在**原生 runner** 上构建，产物会当场跑 `--version` 冒烟，不依赖交叉编译；
- Windows 目前只有基线测试（不阻断），`session-launch` / `agent-hooks` 仍是 POSIX 实现，见 `docs/plans/cli-cross-platform-verify.md`；
- 发布前会跑 `node scripts/check-artifacts.mjs --enforce dist`，任何产物带 HMS / 第三方密钥都会直接失败（SEC-001）；
- macOS 产物是 ad-hoc 签名，首次运行可能需要在「隐私与安全性」里放行；想彻底免打扰需要 Developer ID 公证。

## 扫码配对

两条路：

1. 看终端：启动日志里直接有一个二维码，用手机 App 扫它。
2. 看配对页：从菜单栏打开「设置（安装与配对）」，或在本机浏览器打开带令牌的地址（见下面「管理页鉴权」）。页面显示二维码，并可切换网卡（手机连不上时多半是选错了网段）。

二维码里是一次性令牌：默认 5 分钟有效，兑换一次即作废，比长期不变的配对码安全。

### 管理页鉴权

设置（安装与配对）、一键配置、配对二维码和日志页只允许在**电脑本机**打开，并且必须带 host 生成的本机令牌：

- 桌面 App 的菜单会打开对应页面并自动带上令牌；
- 本机令牌持久化在 `~/.mo-agent/session.json`，host 重启后复用同一个 token；书签和管理 Cookie 不会因为重启失效；
- 直接用本机浏览器访问时，从 `~/.mo-agent/session.json` 取 `token`，例如：

      TOKEN=$(node -p 'require(process.env.HOME + "/.mo-agent/session.json").token')
      open "http://127.0.0.1:7788/setup?token=$TOKEN"

首次用 `?token=` 打开后，host 会换发一张 HttpOnly、SameSite=Strict 的派生 Cookie（不是令牌原文），页面里的链接、二维码图片和 `fetch` 就不用再逐条带令牌。
局域网 / 外网访问这些页面一律返回 403；设备令牌只用于手机端的 `/api/*`，不能打开管理页。

手机侧优先用浏览器的 BarcodeDetector，退化到内置的 jsQR；两者都没有时提示手输配对码。

扫到的地址会以绝对基址存进 localStorage，因此 App 从 capacitor:// 加载时也能连回电脑。

## 启用远程批准

### Claude Code

1. 启动 mo-agent。
2. 配置 hooks（任选一种）：
   - 菜单栏托盘 →「一键配置 Agent…」→「一键配置」；
   - 或在仓库里执行 `npm run hooks:install`；
   - 直接开浏览器时，用上面的「管理页鉴权」方式打开 `/agents?token=...`。
   这些入口共用同一套逻辑：只增删 mo-agent 自己的 hook，写入前自动备份 `~/.claude/settings.json`，
   不会碰其它设置；文件不是合法 JSON 时会拒绝写入。撤销用 `npm run hooks:uninstall`（或一键配置页「移除」）。
3. **重启 Claude Code**，它只在启动时读取 settings.json。
4. 在 Claude Code 里触发一个需要授权的操作：
   - 手机在线：手机弹出授权卡片，点「允许一次」后 Agent 继续；
   - 手机不在线：如果配对过推送设备，host 会先挂起 **60 秒**等 App 连上来（推送点到就能授权）；
     仍然连不上 / 超时：hook 不输出任何内容并退出 0，你在终端里照常看到原来的授权提示。
     窗口可用 `--approval-grace <秒>` 或 `MO_AGENT_APPROVAL_GRACE_MS` 调整。

这条「失败交回本地终端」是刻意设计，见 [docs/adr/adr-0001-observational-first.md](docs/adr/adr-0001-observational-first.md)。

查看当前接入状态：`npm run hooks`。手动配置的旧方式仍保留在
[hooks/claude-code/settings.snippet.json](hooks/claude-code/settings.snippet.json)，仅作兜底。
配置管理的设计与边界见 [docs/guides/agent-hooks.md](docs/guides/agent-hooks.md)。
Claude Code 的 Notification 类型、标题与正文模板见 [docs/reference/claude-code-notifications.md](docs/reference/claude-code-notifications.md)。

### Qoder CN（桌面端「智能工作台」）

Qoder CN 桌面版底层跑的就是 Qoder CLI，transcript 与 Claude Code 同构，所以观测可以直接用。
授权卡有两种输出格式，由 `approvals/hook-cli.mjs` 按 `transcript_path` 自动选择：

- 桌面端（老运行时）：`hookSpecificOutput.decision.behavior = "allow" | "deny"`；
- IDE 1.37+（新运行时）：`hookSpecificOutput.permissionDecision = "allow" | "deny"`。

两种格式**不能同时输出**：新运行时把 `decision` 声明为 string，遇到对象会整段解析失败
（表现为手机上点了允许、hook 也输出了 allow，但 IDE 判成 `no parsed output` 并继续弹窗）。

会话标题直接读 Qoder CN 自己的标题：桌面端取 `main.sqlite` 的 `chat_sessions.title`，
IDE 取 `workspaceStorage/*/state.vscdb` 里的 `aicoding.chat.views`；
优先用 Node 内置的 `node:sqlite`，Node 20 这类环境退到系统 `sqlite3`，两者都没有才退回第一问并截断到 60 字。

IDE 会话显示为独立的 **Qoder CN IDE** 标签；它的 transcript 没有 `stop_reason`，
所以额外用一条 `Stop` hook 补「任务完成」通知（桌面端仍由 transcript 的 `end_turn` 负责）。

一键配置：

    npm run hooks:qoder-cn      # 只配 Qoder CN
    npm run hooks:install       # 配所有支持的 Agent
    npm run hooks              # 查看状态

只写 CN 版的 `~/.qoder-cn/settings.json`（运行时实际读取的配置），改动前自动备份；
`~/.qoder/settings.json` 属于 Qoder 国际版 / IDE，不去碰。
撤销用 `npm run hooks:uninstall`，或在「一键配置 Agent…」页点「移除」。

限制：

- 桌面端没有 prompt/cancel 公开接口，手机上**只能看、批准/拒绝、回答问题**，不能主动发指令或中断；
- `AskUserQuestion` 会先走 `PermissionRequest`：手机上会显示问题与选项，选中后通过
  `updatedInput.answers` 直接回填，不需要再回电脑点一遍。
  这条路径只覆盖把 AskUserQuestion 走权限请求的 Agent（目前确认 Qoder CN）；
  Claude Code 的 AskUserQuestion 不走 `PermissionRequest`，暂不支持在手机上作答；
- 默认「自动审批」模式下很多操作不会弹授权，切到「询问审批」才会稳定出卡；
- 权限模式在手机卡片上会显示（`auto` / `default`），远程批准前可以先看一眼。

手动兜底模板见 [hooks/qoder-cn/settings.snippet.json](hooks/qoder-cn/settings.snippet.json)。

### WorkBuddy（桌面端）

WorkBuddy 桌面端底层跑的是 CodeBuddy CLI，`~/.workbuddy/settings.json` 的 hook 格式
与 Claude Code 同构，所以授权卡直接复用 `PermissionRequest`。
观测走 `~/.workbuddy/projects/*/*.jsonl`，但那是 WorkBuddy 自己的 genie 格式
（`message` / `function_call` / `output_text`），由 `adapters/workbuddy.mjs` 单独解析。

一键配置：

    npm run hooks:workbuddy    # 只配 WorkBuddy
    npm run hooks:install      # 配所有支持的 Agent
    npm run hooks              # 查看状态

只写 `~/.workbuddy/settings.json`，改动前自动备份；撤销用 `npm run hooks:uninstall`，
或在「一键配置 Agent…」页点「移除」。改完需要**新开任务或重启 WorkBuddy** 才生效。

限制与注意：

- 桌面端没有 prompt/cancel 公开接口，手机上只能看、批准/拒绝，不能主动发指令或中断；
- 默认 `auto` / `bypassPermissions` 模式下很多操作不会弹授权，切到「询问审批」（`default`）才会稳定出卡；
- transcript 没有 `stop_reason`，完成由 assistant 消息 + 2 秒静默窗口推断；
- hook 命令写的是安装时的绝对 node 路径（Finder 启动的 WorkBuddy PATH 里没有 node）；换 Node 版本后重跑一次 `npm run hooks:workbuddy`；
- WorkBuddy 自带企微助理的「确认操作」远程批准，两边同时开时会各推一次。

手动兜底模板见 [hooks/workbuddy/settings.snippet.json](hooks/workbuddy/settings.snippet.json)。

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

> Linux / Windows 的跨平台方案、路径矩阵与 Agent 路径差异见 [docs/plans/desktop-cross-platform.md](docs/plans/desktop-cross-platform.md)。
> 当前仍是方案阶段，macOS 分发包与构建流程不受影响。

    ./scripts/build-desktop.sh
    ./scripts/install-desktop.sh   # 装到 /Applications（无写权限时 ~/Applications）并刷新壳缓存

产物：desktop/build/stable-macos-arm64/mo-agent.app（含单文件 host 运行时；默认带语音约 282MB，
不带语音用 `WITH_VOICE=0 ./scripts/build-desktop.sh` 约 46MB）

双击启动后菜单栏出现托盘图标，不占 Dock，并默认打开「实时监控屏」。App 是单实例的：
已经运行时再次双击，不会多出一个托盘图标或第二个 host，而是把已有的监控屏拉到前台
（窗口已关则重新打开监控屏）；macOS 的 reopen 事件也不会把 Dock 图标带出来。

菜单项：

- 设置：打开统一设置中心，左侧是「App 安装与配对 / 钉钉机器人 / Agent 配置 / 语音 / 重启与日志」；
  托盘里的「一键配置 Agent…」「查看日志」也会落到对应 tab
- App 安装与配对：扫码装 App、扫码配对两个二维码
- 钉钉机器人：扫码创建、手动填写、6 位配对码和解绑
- Agent 配置：用单个列表列出所有已启用的 Agent；需要 hook 的显示将写入的 hook、状态和按钮，原生接入的只显示状态
- 语音：启用语音 / 麦克风权限设置… / 语音命令 / 语音口述 / 语音测试（详见 [docs/guides/voice.md](docs/guides/voice.md)）
- 打开监控屏：常驻桌面大窗，实时显示所有会话的运行状态、最近一轮内容、等待处理项和事件流；
  另有筛选、搜索、会话详情和 SSE 实时推送（断线自动轮询兜底），只读展示，不会替你做决定；顶栏「设置」可直接打开设置中心
- 重启服务：重启本地 host 服务，随后自动打开「重启与日志」设置
- 查看日志：打开「重启与日志」设置，上方可重启，下方直接看 host 日志
- 退出

托盘会自己把 host 服务拉起来（默认端口 7788），退出时一并结束。

### 实时监控屏

菜单栏 →「打开监控屏」会打开一个只读的大窗，用来同时盯住所有 Agent：

- 顶部汇总运行中 / 等待处理 / 异常 / 已完成 / 空闲，五项之和等于会话总数；右下角列出各 Agent 数据源及对应会话数，正常显示彩色圆点，异常变红；
  同一个 adapter 的多个运行面会分开显示，例如 Qoder CN 与 Qoder CN IDE；
- 会话列表把「运行中 / 等待 / 异常」置顶，其余按最近更新时间排序，显示最近一轮、轮次、步骤、Token 和运行时长；
- 右侧从上到下依次是实时事件、需要你处理、运行状态：事件区至少 5 条，随窗口和事件量扩展并在内部滚动；待处理固定 2 条高；运行状态固定高度，汇总钉钉通道与本机状态，钉钉的绑定、额度、按接口和最近调用等明细收进「明细」抽屉；
- 点会话打开详情：完整最近一轮、任务清单、计划、子代理和运行信息；
- 支持按活跃 / 运行中 / 等待 / 完成 / 异常筛选，按标题 / 路径 / 最近内容搜索；SSE 推送会话与事件，同时按 host 轮询节奏轻量刷新钉钉连接、进程、数据源等快照字段，断线时自动退化为整份快照轮询。
  「活跃」和手机端「只看活跃」同口径：运行中、有待处理请求、当前选中，或最近 6 小时有更新（不在运行的分支除外）。

监控屏和日志页一样只允许本机访问（回环地址 + 本机令牌），并且**只读**：批准和回答仍在手机或终端完成。
顶栏的「设置」会打开设置中心；设置中心关闭后监控屏保持原样。

### 运行时与升级

构建时会把 host 编译成单文件，并连同 app/web、adapters/profiles、HMS 默认配置一起打进 .app。
首次启动时安装/更新到：

    ~/Library/Application Support/mo-agent/runtime

- 升级 .app 后再次启动，会按 runtime.json 的版本号自动覆盖运行时；
- 首次安装会重写 .app 内的 Info.plist；install-desktop.sh 会在最终签名前补回
  LSUIElement 和麦克风用途说明，避免 App 出现在 Dock；
- 用户数据（配置、设备令牌、push token）在 ~/.mo-agent，升级不会动；
- 因此分发包不再依赖本机仓库路径，也不需要用户安装 Node；
- 开发时设置 MO_AGENT_ROOT=<仓库路径> 可直接运行源码。

HMS 推送的默认配置（含 App Secret）只放在本地 `host/notify-defaults.json`，已加入 .gitignore：

- **本地构建**：文件存在就打包进 runtime，装出来的 App 开箱可推送；`MO_AGENT_DESKTOP_HMS=0` 可强制不带；
- **CI 构建**：一律不带（规则在 `scripts/desktop-hms.mjs`，有单测），构建照常成功，只是 HMS 通道不会自动配置；
- **带密钥的包只能本机自用**：不能上传 Release、不能分发。发布前跑
  `node scripts/check-artifacts.mjs --enforce <产物>`，扫到 `appSecret` / `client_secret` / `api_key` 会直接失败。

## 扫码装 App + 扫码配对

从菜单栏打开「设置（安装与配对）」（本机浏览器需按「管理页鉴权」带令牌访问 `/setup`），页面两步：

1. 第 1 步「装 App」：手机扫码下载 APK（需允许安装未知来源应用）；
2. 第 2 步「配对」：打开 App 后点「扫码配对」扫第二个码，自动完成连接。

APK 由 GET /app.apk 直接提供，来源是 app/android/app/build/outputs/apk/debug/app-debug.apk。
桌面 App 构建时会把该 APK（和 version.json）一起打进运行时，所以分发包里自带安装包；
更新 APK 后需要重新构建桌面 App，分发包里的安装包才会更新。
页面底部可切换网卡（手机连不上时多半是选错网段）。

App 在前台时保持屏幕常亮（`FLAG_KEEP_SCREEN_ON`），手机可以一直放在桌上盯着 Agent 状态；
退到后台或按电源键后即恢复系统息屏，不需要额外权限，也不持有常驻唤醒锁。

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

通知标题统一为 `<类型> [Agent]`（如 `授权请求 [Claude Code]`），正文为 `<会话> · <内容>`；
分级仍在 core/notify.mjs：授权 / 提问 / 失败 = critical，任务完成 = normal，同一件待办只提醒一次。

重新打包安装：

    ./scripts/build-android.sh
    adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk


## 语音免手确认

Agent 卡在授权时，host 用 TTS 念出动作、目标和 4 位口令，你复述口令才放行；说「拒绝」可直接拒绝。
全程本机识别，音频不上传。完整说明（权限、配置、日志、排障、构建）见 [docs/guides/voice.md](docs/guides/voice.md)。

分发包默认自带语音桥、静态 whisper 和 `ggml-small-q8_0` 模型（语音资源约 254MB，App 约 282MB），
装完即用，不需要联网下载模型。

1. 菜单栏托盘 → **语音** → 勾选 **「启用语音」**；
2. 首次使用会弹「mo-agent 语音」麦克风授权，点允许；
3. 之后 Agent 卡住时会念出草稿和口令，你复述口令即可。

同一子菜单还有 **「麦克风权限设置…」**、**「语音命令」** 和 **「语音测试」**；勾选状态存在 `~/.mo-agent/voice.json`，
取消勾选会停用语音组件并关闭语音，不会重启 host。

**语音命令（P1，click-to-talk）**：托盘「语音」→「语音命令」，说一句话。支持「汇报状态」「暂停」「继续」
「切到第 2 个」「切换到 <会话名>」「帮助」。暂停只静音语音播报与语音审批（默认 15 分钟），
审批仍进 pending，手机/终端照常处理；切换只设置「当前关注会话」，不切前台窗口。有副作用的命令
会先回读、再等你明确说「确认」，不认数字口令。

命令期间会显示一个**磨砂半透明浮层**（默认居中、置顶、可拖动、不抢焦点），实时显示听到的原文、意图和最终结果；
结果先显示，再播报。浮层位置会记住，结束后自动隐藏，不再用弹框。

**两段式规则**：语音先转草稿，**不执行、不发送**；TTS 回读后才认明确口令；「拒绝」安全直达；
超时、低置信度、听不懂 → 丢弃并交回手机，绝不猜。最多 3 次尝试。

**已知限制**：仅 macOS；语音命令仍是点按触发（唤醒词与常开麦克风留到 P3）；从播完到开麦约 1 秒延迟。
ad-hoc 签名导致重建/升级后麦克风权限可能重置，重新授权一次即可。

### 构建与开发诊断

    npm run voice:build          # Swift 桥：麦克风 + VAD + 录音
    npm run voice:build:whisper  # whisper.cpp + ggml-small-q8_0（约 252MB，走 hf-mirror）

不想带语音资源时用 `WITH_VOICE=0 ./scripts/build-desktop.sh`（App 约 46MB）。

`host/voice/p0.mjs` 是**开发诊断**工具，不是用户入口：

    npm run voice:demo   # 不碰麦克风，用脚本台词跑完整确认流程
    npm run voice:live   # 真实麦克风 + 真实 broker

## 通知通道（可选）

除了 Android 原生前台服务，host 还能把同一条 notify 事件转发到第三方 App，用来覆盖 iPhone 或跨网段。
配置文件默认是 ~/.mo-agent/notify.json（里面有 channels 数组），示例见 docs/reference/notify.example.json：

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

钉钉单应用机器人（Stream 入站 + 主动推送 + 计次）的完整设计、事件开关和开放平台配置清单见
[docs/spec/dingtalk-bot.md](docs/spec/dingtalk-bot.md)。

## 目录结构

    core/          共享：事件模型、状态词表、事件缓冲（纯逻辑，无 IO）
    adapters/      观测适配层；每 Agent 一份 profile，registry 动态加载（接入见 adapters/README.md）
    approvals/     远程批准：broker + hook 命令行入口
    host/          主程序：HTTP / SSE / 配对 / 二维码 / 编排
    host/agent-hooks.mjs  Agent hooks 配置管理：检测 / 写入 / 备份 / 卸载（设置页与 CLI 共用）
    host/voice/    两段式语音：文本规则、确认状态机、TTS、whisper、常驻 helper 客户端、p0 诊断 CLI
    app/web/       手机端 PWA 源码
    app/android/   Capacitor 原生工程
    app/ios/       暂缓
    desktop/       桌面壳（Electrobun 托盘，含语音开关与语音测试）
    hooks/         各 Agent 的 hook 安装模板
    docs/          adr/ 决策 · research/ 预研 · spec/ 规格 · voice.md 语音手册
    scripts/       probe-dsh（探针）、inspect-sessions（会话排查看派生关系）、e2e-approval（回归）、
                   configure-hooks（终端版 hooks 配置管理）、
                   build-android / build-desktop / build-voice-bridge / build-whisper

## 架构

    L1 进程发现 ┐
    L2 会话日志 ├─► core/hub 统一事件模型 ─► host (HTTP+SSE) ─► app ─► 手机/耳机
    L3 hooks   ┤        (A2A 状态词表)
    L4 tmux    ┘

设计依据：docs/adr/adr-0001-observational-first.md（观察优先，暂不做 ACP 托管）。

事件契约：docs/spec/event-contract.md（统一事件、状态语义与映射；决策见 docs/adr/adr-0003-event-contract.md）。
Agent 能力表：docs/reference/capabilities.md（由 scripts/gen-capabilities.mjs 生成）。
Agent 适配性矩阵：docs/reference/agent-adaptation-matrix.md（研究态总表，含未接入/不可行与证据级别，持续更新）。

## 会话派生关系（分支）

DSH 的会话列表里除了主干会话，还会列出**从主干派生出来的分支**（字段 parentSessionId）。
mo-agent 的处理：

- 手机端「只看活跃」默认**不显示非运行中的分支**（不跑的分支只是历史）；
- 分支在列表里打「分支」标签，meta 行标「分支自其它会话」；
- 分支**正在运行**时仍然显示——那确实是活跃的，你可能要控制它；
- 想看全部时取消「只看活跃」。

排查用：node scripts/inspect-sessions.mjs

自检：npm run check（语法）· npm test（全量单测）

## 接口速查

    GET  /settings             设置中心（?tab=app|dingtalk|agents|voice|system；回环地址 + 本机令牌）
    GET  /setup                旧版设置页（装 App + 配对两个二维码；回环地址 + 本机令牌）
    GET  /agents               旧版一键配置页（已启用 Agent 列表 / 写入内容 / 状态 / 按钮；回环地址 + 本机令牌）
    GET  /pair                 二维码配对页（回环地址 + 本机令牌）
    GET  /pair/qr.svg          二维码图片（回环地址 + 本机令牌，?ip= 可指定网卡）
    GET  /logs                 独立日志页（回环地址 + 本机令牌；设置中心内嵌同一个查看器）
    GET  /logs/data            日志尾部若干行 JSON（回环地址 + 本机令牌）
    GET  /monitor              实时监控屏（回环地址 + 本机令牌；桌面「打开监控屏」进入）
    GET  /monitor/state        监控快照：会话汇总 + 待办 + 进程 + 数据源（回环地址 + 本机令牌）
    GET  /monitor/events       监控 SSE：?since= 断点重放状态事件（回环地址 + 本机令牌）
    POST /api/pair             配对：{pin} 或 {qrToken}
    GET  /api/state            全量快照（会话 + 待批准 + 进程）
    GET  /api/session-history  会话历史轮次（?sessionId=&limit=，按需读取）
    GET  /api/events           SSE 事件流（?since= 断点重放；固定 message 信封）
    POST /api/approve          手机决定：{id, decision}
    POST /api/prompt           发送指令（仅 control 含 prompt 的会话；Claude 只读返回 409）
    GET  /local/hooks          各 Agent hook 配置状态（仅回环地址）
    POST /local/hooks/apply    hooks 安装/卸载：{agentId, action, dryRun}（仅回环地址）
    POST /setup/hooks/apply    设置页表单动作（回环地址 + 本机令牌 + csrf，303 回 next 白名单或 /agents）
    POST /local/approval       hook 回调（本机令牌）
    POST /local/voice/reload   动态启停语音组件（本机令牌；不重启 host）
    GET  /local/pair-payload   取当前二维码载荷（本机令牌，供桌面端渲染）

    SSE  event: message        {v,seq,at,type,payload}（M4 起唯一格式）；type=notify 为通知出口

管理页鉴权：`x-mo-agent-local: <token>` 请求头、`?token=<token>`，或首次访问后换来的
`mo_agent_admin` HttpOnly Cookie；非回环地址直接 403。

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
    node scripts/icon-preview.mjs   # 生成 docs/assets/icon-preview.png（含深色底反色模拟与 18px 放大）
    ./scripts/build-desktop.sh && ./scripts/build-android.sh

改图标只改 scripts/icon-art.mjs；改完两端都要重新打包。
