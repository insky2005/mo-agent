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

### 升级

装好之后随时可以查新版并原地升级（只替换 `mo` 自己这个文件）：

```bash
mo upgrade --check   # 只检测：当前 / 最新
mo upgrade           # 下载 → 校验 sha256 → 替换
```

只认 `cli-v*` 的 Release，没有 `.sha256` 的版本会被拒绝。源码运行（`node cli/mo.mjs`）不会自替换，
用 `git pull` + `bash scripts/install-cli.sh`。

如果提示 `command not found`，把 `~/.local/bin` 加进 PATH：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

---

## 2. 桌面 App（macOS）

> 只有 **Apple Silicon（arm64）** 版本。Electrobun 不提供 macOS Intel 运行时，Intel 机器请用 CLI。

从 Releases 下载 `mo-agent-desktop-<版本>-macos-arm64.dmg`，双击打开后把 **mo-agent.app** 拖进 Applications：

```bash
open /Applications/mo-agent.app
```

偏好命令行的也可以用 `hdiutil` 挂载后拷贝：

```bash
hdiutil attach mo-agent-desktop-<版本>-macos-arm64.dmg
cp -R /Volumes/Mo\ Agent/mo-agent.app /Applications/
hdiutil detach /Volumes/Mo\ Agent
```

首次打开可能被 Gatekeeper 拦（产物是 ad-hoc 签名，没有 Developer ID 公证）：

```bash
xattr -dr com.apple.quarantine /Applications/mo-agent.app
```

或到「系统设置 → 隐私与安全性」里点「仍要打开」。

启动后菜单栏出现图标，不占 Dock。

---

## 3. 手机 App（Android）

**有 host 在跑**（桌面 App，或源码仓库里 `npm start`）时最省事：打开设置页「安装与配对」，
扫第一个二维码，APK 由 host 直接发给你，不用自己找文件。

没有 host 的话，这两条也不依赖源码：

| 方式 | 怎么做 |
|---|---|
| 手动下载 | 在 Releases 里点 `mo-agent-android-<版本>.apk`（手机浏览器也能下） |
| 装 CLI 时顺带拿 | `curl ... \| bash -s -- --with-apk`，存到 `~/.mo-agent/app.apk`，之后 host 的 `/app.apk` 用它 |

> 装好的 APK 需要配对才有用：配对必须由 host 服务，所以**只装了 CLI 二进制、没装桌面也没源码**时，手机端暂时用不上。

要求 Android 7.0+（minSdk 23）。

---

## 4. 从源码（开发者）

```bash
git clone https://github.com/insky2005/mo-agent.git
cd mo-agent
npm ci
npm start                       # 直接跑 host（前台）
```

### CLI

```bash
bash scripts/build-cli.sh       # 产物在 cli/dist/mo（本机架构）
bash scripts/install-cli.sh     # 构建并装到 ~/.local/bin
```

交叉编译指定平台（需要 bun）：

```bash
TARGET=bun-linux-x64 OUT_NAME=mo-linux-x64 bash scripts/build-cli.sh
```

### 桌面 App（macOS arm64）

前提：macOS + bun + [hutch](https://hutch.blackboard.sh)（Electrobun 工具链，脚本会提示安装命令）。

```bash
bash scripts/build-desktop.sh            # 产物 desktop/build/stable-macos-*/mo-agent.app
bash scripts/install-desktop.sh          # 装到 /Applications（无写权限时退回 ~/Applications）
```

常见变体：

| 需求 | 命令 |
|---|---|
| 轻包（不含 254MB 语音资源，约 46MB） | `WITH_VOICE=0 bash scripts/build-desktop.sh` |
| 顺带打包 APK（扫码即可装） | 先 `bash scripts/build-android.sh`，再构建桌面 |
| 首次构建要下模型 | 直接跑，脚本会调 `build-whisper.sh`（约 252MB） |

构建时会把 HMS 默认配置一起打进去，除非显式关掉：

```bash
MO_AGENT_DESKTOP_HMS=0 bash scripts/build-desktop.sh   # 发布用：不带任何凭据
```

### Android APK

前提：JDK 21 + Android SDK（默认读 `$ANDROID_HOME`，或 `~/Library/Android/sdk`）。

```bash
bash scripts/build-android.sh            # 产物 app/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk
```

- 脚本会自动 `npx cap sync android`，并把 `versionCode` 加一（CI 里用 `MO_VERSION_CODE` 固定）；
- 想用正式签名：把 keystore 放到 `app/android/app/keystore/`，写一份 `keystore.properties`（两者都已 gitignore）；没有就退回仓库里的 debug key；
- 不带 `agconnect-services.json` 也能构建，只是没有 HMS 推送能力——CI 就是这么构建的；
- 从本机直接取发布版（不构建）：`bash scripts/fetch-apk.sh`，默认下到 `~/.mo-agent/app.apk`，也可 `bash scripts/fetch-apk.sh /tmp/mo.apk`。

> 更多细节（Electrobun 布局、语音资源、签名注入、CI 环境差异）见 [DEVELOPMENT.md](DEVELOPMENT.md)。

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
