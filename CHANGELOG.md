# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

平时的改动写在 `## [Unreleased]` 下。**发版时**把它改成 `## [V] - 日期` 并留一个空的 Unreleased ——
CI 会用 `node scripts/check-changelog.mjs --release` 校验这一点；平时的 `npm run check` 只要求 Unreleased 段存在。

## [Unreleased]

### 新增

- **`mo daemon install`：只装 CLI 也能补齐 host**。此前 host 只随桌面 App 分发，而 `get-cli.sh` 只装一个 `mo` 二进制——只装 CLI 的用户没有 host，手机批准、监控、钉钉全都用不了。现在按 `mo-agent-runtime-<os>-<arch>.tar.gz` 从 Release 下载（可 `MO_AGENT_HOST_URL` 覆盖）→ 校验 sha256 → 解到 findHost 早已预留的 `~/.mo-agent/runtime`。`mo doctor` 增加 host 行，`mo daemon status` 在没有 host 时直接给出 `mo daemon install`。
- `fetchApk` 与 host 运行时安装共用 `cli/lib/download.mjs`（流式下载 + 边算 sha256 + 失败不留半个文件）。
- **Router P0（结构地基）**：会话新增 `role`（`router` / `worker` / `unknown`），`hub.list` 支持按角色过滤；`core/router.mjs` 定下能力面策略（只读四个 + mo 的 MCP、运行时准入 fail-closed）；`host/router/argv.mjs` 把启动参数构造成纯函数，工具面收窄落在命令行上；契约新增 `router` 格式（指挥台版，不含 shell 示例）。
- **Pi 接入**：观测 `~/.pi/agent/sessions` 的 JSONL 树；设置页可一键安装控制扩展，支持手机发送指令 / 中断（不做工具审批）。
- `mo upgrade`：检查最新 CLI Release 并原地升级。默认「检查 → 下载 → sha256 校验 → 原子替换自己的二进制」，
  支持 `--check` / `--dry-run` / `--json` / `--version <标签|版本>` / `--force`；替换前先在临时文件上跑
  `--version` 验证产物，源码运行与不可写目录会明确拒绝。`mo doctor` 用本地缓存提示「有新版」，不额外联网。

- **Router P1（垂直切片）**：`mo router start|stop|status|restart`，生命周期归 host（`/local/router/*` 本机接口），CLI 只发请求；私有配置目录 + workbench + ROUTER.md 自动生成；启动脚本 0600/0700，凭据通过环境变量注入且不写进 `router.json`；Pi 以 `--tools read,grep,find,ls,mcp__mo__*` 启动，会话以 `role: "router"` 注入 hub。

- **Router P2（产品化）**：`mo router runtime install|list|prune` —— 按 `host/router/runtimes.json` 的版本 pin 把运行时私有安装到 `<runtimeRoot>/routers/pi/<版本>`（npm 装进 staging → 自检 → rename，私有 cache，失败不留半个安装，Node 下限取自运行时清单）；`mo router setup|reset` —— 凭据落 `0600`、可测通（`--no-test` 跳过）、模型以 `--provider/--model` 显式传入而不依赖运行时配置；控制扩展与 `mcp.json` 一并写进私有配置目录；设置页新增「指挥台」tab（只读状态）；`mo doctor` 增加指挥台检查项。

- **指挥台接入 `mo setup`**：新增「指挥台」步骤，一次配齐运行时安装 + provider/model/key，默认测通；交互时先问再装，非交互必须显式 `--router`（不会因为 `--yes` 就下载 150MB），`--dry-run` 只输出计划。新增 `--router-provider/--router-model/--router-key/` 与 `--no-test`。

- **`mo router` 的 TAB 补全补齐**：顶层命令、子命令、`runtime install|list|prune`、`--provider` 取值、以及 `mo setup --only router` 的步骤名。补全表是硬编码白名单，新命令不加就永远不会出现。
- **裸 `mo router` 等同于 `mo router start`**：打开指挥台不用记两层子命令，与 `mo upgrade` / `mo mcp` 的"默认子命令"一致。
- **`mo router` 自动拉起 host**：需要 host 的动作（start / setup / reset / runtime install / prune）在连不上时先 `mo daemon start` 一次再重试，不用记两条命令；`status`/`stop`/`runtime list` 保持不自启。`MO_AGENT_NO_AUTOSTART=1` 或 `ctx.autoStart:false` 可关闭。host 是旧构建时（没有 `/local/router/*`）给 `E_ROUTER_HOST_OLD` 与明确指引，而不是裸 404。

- **APK 下载有进度了，且 `mo router` 不再顺手下载它**：`fetchApk` 改成流式落盘（顺带算 sha256），TTY 下在 stderr 显示百分比与 MB；`mo daemon start` 新增 `--no-apk`（或 `MO_AGENT_NO_APK=1`），`mo router` 拉起 host 时带上它——APK 只跟"手机装 App"有关，与指挥台无关。

- **能看见 host 到底用的是哪一份**：`mo daemon status` 新增 `host` 行（来源 · 路径 · 编译时间）；`E_ROUTER_HOST_OLD` 会把当前 host 的来源与时间打出来，并给出"源码 host / 桌面 host"两条具体命令。

### 重构

- **cli / host 分层归位（P0 + P1）**：Router 的 10 个实现模块从 `host/router/*` 下移到 `cli/lib/router-*.mjs`（argv / script / terminal / node / runtimes / install / credentials / probe / paths / manager），`fsx` 并入 `cli/lib/fsx.mjs`；host 只保留 `router-session.mjs`——启动时 `adopt()` 扫 `router.json` + pid，发现活着的 Router 就注入 hub 接管控制面。`cli → host` 从 6 处降到 **0**，`KNOWN_DEBT` 清空。
- **manager 的 hub 变可选**：改为 `onSession` 回调 + 可选 hub，为"CLI 自己拉起 Router、host 后到接管"铺路。
- 补全表 `complete.mjs` 从应用层归位到接口层（`cli/commands/complete.mjs`），消除唯一一处 `cli/lib → cli/commands` 的反向依赖。
- **`mo router start` 默认就在当前终端跑**（TTY 下），Ctrl-C 停；要开新窗口用 `--window`，非 TTY（脚本 / CI）自动走窗口。前台路径不经过 host。
- **`mo router` 全动作本地化**：start / stop / status / setup / runtime 不再走 host 的 HTTP（也不再顺手拉起 daemon），`E_DAEMON_DOWN` 与 `E_ROUTER_HOST_OLD` 从这条路径彻底消失；没 host 时输出会提示"远程控制暂不可用"。
- **Pi 控制扩展改为等待 host 而不是退出**：之前拿不到 `session.json` 就直接结束循环，导致"先起指挥台、后起 host"永远接不上；现在退避重试，启动顺序不再重要。
- **Router 运行时加 `--no-skills`**：它的契约是 `ROUTER.md`；通用 `mo` 技能里全是 shell 命令示例，而 Router 没有 shell，技能发现又是全局的（含 `~/.agents/skills`），不显式关掉就会读到。
- **技能里加了角色判定**：开场先分辨"主 Agent（派单）"与"执行者（按卡干活）"。执行者**不需要**加载技能——它要的一切都在任务卡信封里（交付物、验收、回执路径与 JSON 模板）；AGENTS.md 的指针也注明了"仅主 Agent"，并补一句执行者该怎么做。
- **启动脚本里不再有 API key**：`start.sh` 改为 0644 且只含 pid/cd/exec，凭据投影到单独的 `secrets.sh`（0600），**只在运行期间存在**，`stop` 或前台退出即删除；`credentials.json` 仍是唯一事实源。
- **`mo router` 不再依赖 host 存在**：`start` / `stop` / `status` 在 host 缺席（或旧构建）时退回 `cli/lib/router-manager` 本地执行，`E_DAEMON_DOWN` 从这条路径消失；host 起来后 `adopt()` 接管控制面。
- 新增 [cli/ 分层重构清单](docs/plans/cli-layer-split.md)：把 cli/ 按"应用层 / 接口层 / 工具层"盘点，列出 5 个混住的具体症状（S1–S5）与 P0–P2 分阶段清单、逐文件搬迁表与验收。
- **依赖方向有了守卫测试**：`scripts/architecture.test.mjs` 扫描真实 import 边，未登记的白名单外依赖直接失败；已知违规（`cli → host` 6 处）写进 `KNOWN_DEBT`，只许减少不许新增，并额外断言 `core` 无对外依赖、前端与壳不 import 后端。
- **重写 [架构总览](docs/architecture.md)**：按实测 import 矩阵重画分层（core → cli → host → 用户面，adapters/approvals 为旁支），补齐 `cli` / `app` / `desktop` / `hooks` / `integrations` 的职责与边界、四个运行体的依赖关系，并把唯一一处反向依赖（`cli → host/router/*`）登记为待还债务。
- 新增 [ADR-0004](docs/adr/adr-0004-private-router-runtime.md)、[spec/router.md](docs/spec/router.md) 与 [实现计划](docs/plans/router-implementation.md)：确定 Router（指挥台）是 mo 私有安装、版本锁定、可替换的运行时，与 Worker 平面分开；能力面遵循“读由 runtime 给，写由 mo 给”；ADR-0001 补上“仅约束 Worker 平面”的范围说明。
- 0.2.0 发布后把开发版本号升到 0.3.0（本轮含新增功能，按次版本 +1）。

### 修复

- **`mo router` 明明 host 在跑却报 `E_DAEMON_DOWN`**：`readHostSession` 只读 `session.json` 的 `port` 字段，而 host 实际写的是 `url`（只有 `url` 没有 `port`），于是永远判定"没在运行"。现在两种都认，并补了只带 `url` 的用例。
- **被 `mo router` 拉起 host 时刷一屏访问信息**：`mo daemon start` 新增 `--quiet`（内部用），嵌套调用只留一行"host 已在运行 / 已启动"。
- **运行时启动器被钉在裸 `node` 上**：`resolveNode` 从 PATH 命中时返回的是字符串 `"node"`，直接写进了 shim，等于没钉 Node（GUI 启动的终端、nvm 切换都会换版本甚至找不到）。现在解析成绝对路径；已装的运行时在 `mo router start` 或 `mo router runtime install` 时自动修复 shim。
- **`mo setup` 的「默认执行者 / 默认终端」在已配置时看起来像"步骤没了"**：两步都是幂等短路（配过就不问），非交互下这是对的，交互下则让人以为漏了步骤。现在交互模式会问一句"已是 X，要换吗？（y/N）"，回车保持；非交互的跳过文案补上 `mo worker use` / `mo terminal use` 的改法。
- **`mo setup` 的指挥台步骤在单文件二进制里报 `E_ROUTER_RUNTIME_MISSING`**：运行时清单原本是 `runtimes.json`，靠 `fs` 在运行时读取，而 `bun --compile` 只内联 JS 模块，路径会变成不存在的 `/$bunfs/root/runtimes.json`。改成 `host/router/runtimes.mjs`，并加一条"不许再引用 runtimes.json"的回归测试。
- **Router 凭据写到 `~/.mo-agent/.mo-agent/router/`**：`dataDir`（`~/.mo-agent`）与 `osHome`（`~`）两个语义混用，路径被重复拼了一次。`host/router/paths.mjs` 现在显式区分两者，`routerRoot(dataDir)` 不再内含 `.mo-agent`。

## [0.2.1] - 2026-10-31

### 修复

- `mo doctor` 的自检项改用中文名称，`cwd-project` 改为「当前目录」并直接说明是否属于项目。
- `mo doctor` 在已登记项目的**子目录**里不再误报「不在项目内」。
- `mo setup` 不再把项目相关自检算作「待处理」，家目录下也不再建议就地 `mo project init`。

## [0.2.0] - 2026-10-31

首个对外版本（pre-release）。

### 新增

- **任务卡工作流**：`mo task create / confirm / approve / reject / dispatch / status / list / cancel / verify / logs`；
  人批准会校验卡片指纹，验收按 `run:` / `check:` / `human:` 三类执行，全过程写账本。
- **执行者与终端**：`mo worker` 支持无头与会话型执行者、项目级覆盖、默认执行者；`mo terminal` 注册终端并设默认。
- **记忆**：`mo memory` 的初始化、召回、候选与裁决；派单时按卡片内容自动注入同一批条目。
- **常驻服务**：`mo daemon start / status / open / stop`——后台启动、幂等、标注 host 来源、令牌脱敏、`--browser` 与 `--show-token`。
- **Agent 接入**：Claude Code、Qoder CN（含 IDE 标题）、WorkBuddy、DeepSeek Harness；`mo agent describe / add`、`mo mcp`、`mo skill install`。
- **手机端（Android）**：扫码配对、锁屏推送、远程批准与回答；`/app.apk` 直接分发安装包。
- **桌面托盘（macOS）**：菜单栏常驻、实时监控屏、设置中心（安装配对 / 钉钉 / Agent / 语音 / 系统）、语音浮层。
- **通知**：HMS 推送、钉钉机器人、Bark / 企业微信 / 飞书 / 通用 webhook，统一模板与分级。
- **语音**：口令确认、口述、语音命令与浮层。
- **安装与分发**：`installer/get-cli.sh` / `get-cli.ps1` 一条命令安装；按资产解析 Release、SHA256 校验、`--with-skill` / `--with-apk`。
- **CI/CD**：`ci.yml` 三平台矩阵；`cli-release` / `apk-release` / `desktop-release` 三套独立发版；APK 签名走 Secrets。

### 变更

- 三个组件改用前缀 tag（`cli-v*` / `apk-v*` / `desktop-v*`），安装脚本不再依赖 `releases/latest`。
- 安装入口集中到 `installer/`，`scripts/install-remote.sh` 保留为兼容转发。
- 仓库统一使用 LF 行尾（`.gitattributes`），修正 Windows 上生成物校验的误报。

### 修复

- 桌面分发包不再携带 HMS App Secret（`MO_AGENT_DESKTOP_HMS=0`），并新增产物密钥递归扫描（SEC-001）。
- `mo … | head` 等管道提前关闭时不再抛 EPIPE 堆栈。
- 桌面 App 已在运行时，`mo daemon start` 不再误报「启动成功」。
