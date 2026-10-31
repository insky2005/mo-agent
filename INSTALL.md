# 安装

三种装法，按场景挑一个：

| 你想做什么 | 装什么 | 怎么装 |
|---|---|---|
| 在终端里建卡、派单、看账本 | **CLI**（单文件二进制，不需要 Node） | 一条命令 |
| 菜单栏常驻 + 手机远程批准 + 语音 | **桌面 App**（macOS Apple Silicon） | 下载 zip |
| 改代码 | **源码** | `npm ci` |

---

## 1. CLI（推荐先装这个）

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/installer/get-cli.sh | bash
```

### Windows（PowerShell）

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/insky2005/mo-agent/main/installer/get-cli.ps1 | iex"
```

装到：

- macOS / Linux：`~/.local/bin/mo`
- Windows：`%USERPROFILE%\.local\bin\mo.exe`

安装脚本会：按平台挑产物 → 下载 → 用同名 `.sha256` 校验 → 落盘 → 打印 PATH 提示。

### 常用参数

| 参数 / 环境变量 | 作用 |
|---|---|
| `--with-skill` | 顺带给 Claude / Codex / Qoder 等装 mo 技能 |
| `--with-apk` | 顺带把手机安装包下到 `~/.mo-agent/app.apk` |
| `MO_VERSION=cli-v0.2.0` | 装指定版本（默认找最新带 CLI 资产的 Release） |
| `MO_BIN_DIR=/some/bin` | 换安装目录 |
| `MO_AGENT_REPO=owner/repo` | 从 fork 装 |
| `MO_CLI_BASE_URL=file:///path/to/dist` | 从本地目录装（调试发布用） |

### 验证

```bash
mo --version
mo doctor
```

如果提示 `command not found`，把 `~/.local/bin` 加进 PATH：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

---

## 2. 桌面 App（macOS）

> 只有 **Apple Silicon（arm64）** 版本。Electrobun 不提供 macOS Intel 运行时，Intel 机器请用 CLI。

从 Releases 下载 `mo-agent-desktop-<版本>-macos-arm64.zip`，解压后：

```bash
cp -R mo-agent.app /Applications/
open /Applications/mo-agent.app
```

首次打开可能被 Gatekeeper 拦（产物是 ad-hoc 签名，没有 Developer ID 公证）：

```bash
xattr -dr com.apple.quarantine /Applications/mo-agent.app
```

或到「系统设置 → 隐私与安全性」里点「仍要打开」。

启动后菜单栏出现图标，不占 Dock。

---

## 3. 手机 App（Android）

不需要单独下载：桌面端或 CLI 起来后，打开设置页的「安装与配对」，扫第一个二维码即可安装。

也可以手动从 Releases 拿 `mo-agent-android-<版本>.apk`，或在本机执行：

```bash
bash scripts/fetch-apk.sh                      # 下到 ~/.mo-agent/app.apk
bash scripts/fetch-apk.sh /tmp/mo.apk          # 或指定路径
```

要求 Android 7.0+（minSdk 23）。

---

## 4. 从源码（开发者）

```bash
git clone https://github.com/insky2005/mo-agent.git
cd mo-agent
npm ci
npm start                       # 直接跑 host（前台）
```

构建并安装 CLI 到本机：

```bash
bash scripts/build-cli.sh       # 产物在 cli/dist/mo
bash scripts/install-cli.sh     # 构建并装到 ~/.local/bin
```

桌面与 Android 的构建见 [DEVELOPMENT.md](DEVELOPMENT.md)。

---

## 5. 装完先做这两件事

```bash
mo setup     # 第一次装配：目录、配置、记忆、默认执行者、技能、MCP（幂等，不碰仓库）
mo doctor    # 自检：node / 目录 / 记忆库 / 项目
```

想看 `mo setup` 会做什么而不真的执行：`mo setup --dry-run`。

---

## 6. 卸载

```bash
rm ~/.local/bin/mo                     # CLI（Windows: del %USERPROFILE%\.local\bin\mo.exe）
rm -rf ~/.mo-agent                     # 配置、账本、设备令牌（数据在这里，删前想清楚）
```

桌面 App 直接拖到废纸篓；它的运行时在 `~/Library/Application Support/mo-agent/`。

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `找不到 mo-darwin-arm64 的 release` | 还没发过 `cli-v*` 版本，或仓库私有 |
| macOS 提示「无法验证开发者」 | ad-hoc 签名，用上面的 `xattr` 或隐私设置放行 |
| Windows SmartScreen 拦截 | 未做代码签名，点「更多信息 → 仍要运行」 |
| `mo` 装好后命令找不到 | `~/.local/bin` 不在 PATH |
| 手机连不上 | 确认手机与电脑同一网段；`mo daemon status` 看地址 |

更多排查见 [USAGE.md](USAGE.md) 的「排障」。
