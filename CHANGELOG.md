# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

平时的改动写在 `## [Unreleased]` 下。**发版时**把它改成 `## [V] - 日期` 并留一个空的 Unreleased ——
CI 会用 `node scripts/check-changelog.mjs --release` 校验这一点；平时的 `npm run check` 只要求 Unreleased 段存在。

## [Unreleased]

### 新增

### 变更

- 0.2.0 发布后把开发版本号升到 0.3.0（本轮含新增功能，按次版本 +1）。

### 修复

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
