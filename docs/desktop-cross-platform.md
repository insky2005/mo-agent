# 桌面端跨平台落地方案：Linux / Windows

状态：**方案（未实现，先落文档）**　日期：2026-10-22
适用：mo-agent 0.2.x · Electrobun 2.0.2 · Hutch 0.27.1 · Bun 1.3.x

## 0. 结论先行

1. **不做 macOS 上的交叉编译。** Electrobun 的 devkit 按平台分发（`desktop/.hutch/dependencies.lock` 里锁定的是 `macos-arm64`，《预研》也记录了这一布局），构建必须发生在目标系统上。Linux/Windows 用 CI 矩阵各自原生构建，macOS 继续走现有脚本。
2. **用户数据继续用 `~/.mo-agent`，不迁到 `%APPDATA%`。** Windows 上 `~` 展开为 `%USERPROFILE%`，即 `C:\Users\<user>\.mo-agent`；保持与 macOS/Linux、Agent 文档、既有 hook 配置一致。运行时、日志、WebView 缓存这些**系统级目录**才按平台分开。
3. **路径解析只写一次。** 新增 `core/platform-paths.mjs`（纯函数，可注入 platform/env/home），host、桌面壳、hook CLI 全部改用同一套；禁止再出现 `path.join(homedir(), "Library", ...)` 或 `"file://" + path`。
4. **Agent 路径差异用 profile 声明，不在适配器里写死。** profile 增加平台映射，统一支持 `~`、`%VAR%` 展开；hook 命令按 Agent 在 Windows 的 shell 生成；进程扫描在 Windows 改用 `Get-CimInstance`。
5. **语音继续 macOS-only。** 语音桥是 Swift + AVFoundation + TCC 的产物，Windows/Linux 在 P5 之前不提供入口；其余托盘、面板、Agent 配置、配对、日志能力先跨平台。
6. **分阶段验收，macOS 零回归。** P1 路径抽象 → P2 Windows 桌面壳 → P3 Linux 桌面壳 → P4 构建/CI/分发 → P5 语音。

本文只定方案、改动面与验收标准，**不含代码改动**。

## 1. 目标与非目标

### 目标

- 同一份 `desktop/` 源码，在 macOS / Windows 10+ x64 / Linux x64（Ubuntu 22.04+）上构建并启动托盘应用。
- 托盘、设置面板、`/agents` 一键配置、日志、重启服务、单实例、局域网配对这些主路径可用。
- `~/.mo-agent` 及其下所有文件在三个平台解析到正确位置，不丢配置、不出现跨平台串用。
- 各 Agent 的配置目录、transcript 目录、标题数据库、hook 命令、进程发现按平台正确工作；找不到时安全降级。
- macOS 现有行为、产物布局、安装脚本不变。

### 非目标（本阶段明确不做）

- 从 macOS 交叉编译 Windows/Linux 产物。
- Windows/Linux 的语音（录音、ASR、TTS、浮层/浮球）。菜单里隐藏或置灰，不伪造可用状态。
- WSL、Git Bash、远程 Linux 里的 Agent 发现。它们有独立的 `$HOME`，mo-agent 只观察「当前系统用户可见的进程与文件」。
- Windows ARM64。Electrobun 2.0.2 的 `api/shared/platform.ts` 明确 Windows 固定 x64。
- 正式代码签名/公证（Windows Authenticode、macOS Developer ID）。先出未签名产物，签名另立任务。
- 自动更新服务端改造。先保证更新包/JSON 按平台产出，发布流程后续接入。

## 2. 现状：macOS 专属点清单

下表是走查后确认需要在 P1-P4 处理的点，行号对应当前源码。

| 位置 | 现状 | 跨平台影响 | 处理 |
|---|---|---|---|
| `desktop/src/bun/index.ts:25` | runtime 固定 `~/Library/Application Support/mo-agent/runtime` | Windows/Linux 路径错误 | 改用 `platformPaths.runtimeRoot` |
| `desktop/src/bun/index.ts:28` | 日志固定 `~/Library/Logs/mo-agent` | 同上 | `platformPaths.logDir` |
| `desktop/src/bun/index.ts:30-31,38,63` | `.mo-agent` 直接 join | 可工作，但散落、无 env 覆盖 | 统一 `platformPaths.userDataDir` |
| `desktop/src/bun/index.ts:146-177` | `resolveNode` 只找 homebrew/nvm/fnm/volta 的 macOS 路径 | Windows 找不到 node | 平台分支 + `.exe` + Windows 安装器路径 |
| `desktop/src/bun/index.ts:217-289` | 系统 `tar` 解包、`chmod`、直接 rename 覆盖 runtime | Windows 无 `chmod`、文件可能被占用 | 版本化 runtime、`tar.exe`/内置解包、重试 |
| `desktop/src/bun/index.ts:300-346` | spawn host，PATH 追加 `/opt/homebrew/bin:/usr/local/bin` | Windows PATH 分隔符/目录错误 | `path.delimiter` + 平台目录，`windowsHide` |
| `desktop/src/bun/index.ts:420,457` | `"file://" + LOG_DIR` | Windows 生成非法 file URL | `pathToFileURL` |
| `desktop/src/bun/index.ts:627,635` | `x-apple.systempreferences:` | Windows/Linux 打不开 | 平台分支：`ms-settings:privacy-microphone` / 提示 |
| `desktop/src/bun/index.ts:644` | 读 `~/.mo-agent/session.json` | 路径散落 | `platformPaths.sessionFile` |
| `desktop/src/bun/index.ts:1498,1503-1504,1509-1510` | Tray template、`app.on("reopen")`、`setDockIconVisible`、ApplicationMenu、Carbon | 非 macOS 无效或报错 | 平台 gate；Carbon 仅 darwin |
| `desktop/src/bun/index.ts:1253-1359,800-881` | 语音浮层/浮球使用 AppKit `styleMask`、`setVisibleOnAllWorkspaces` | Windows/Linux 行为未验证 | P5 再移植；P2/P3 不创建 |
| `desktop/src/bun/single-instance.ts:73-87` | `linkSync` 硬链接原子锁 | exFAT/SMB 等可能不支持 | 改 `openSync(..., "wx")` |
| `host/index.mjs:40` | 默认 host 日志写 `~/Library/Logs/mo-agent` | Windows/Linux 路径错误 | `platformPaths.logFile` |
| `host/index.mjs:42` | devices 固定 `.mo-agent` | 可工作，但需 env 覆盖 | `platformPaths.userDataDir` |
| `host/index.mjs:480-486` | session 固定 `.mo-agent` | 可工作 | 同上 |
| `host/agent-hooks.mjs:80-97` | node 解析只有 `/opt/homebrew`、`/usr/local`、`/usr/bin` | Windows 找不到 node | 平台分支 + `where node` + 安装器路径 |
| `host/agent-hooks.mjs:110-115` | hook 命令固定 POSIX 双引号 | PowerShell 下不执行 | 按 `hooks.shell` 生成 |
| `host/config.mjs:9` | `~/.dsh` 直接 join | 可工作，建议统一 | 用 `expandPath`/platform paths |
| `adapters/process-scan.mjs:14` | 只跑 `ps -axo` | Windows 无 `ps` | Windows 用 PowerShell CIM，失败降级 |
| `adapters/qoder-cn-titles.mjs:63-72` | 标题库/IDE 目录固定 `~/Library/Application Support` | Windows/Linux 找不到 | 按平台解析 |
| `adapters/qoder-cn-titles.mjs:123-131` | sqlite3 只找 POSIX 路径 | Windows 无 sqlite3 | Windows 路径 + PATH；优先 `node:sqlite` |
| `adapters/qoder-cn.mjs:41` | `includes("/transcript/")` | Windows 反斜杠不命中 | 统一分隔符/正则 |
| `adapters/dsh-monitor.mjs:266` | `cwd.split("/").pop()` | Windows 取不到目录名 | `path.basename` |
| `host/voice/helper-client.mjs:21` | `execFile("open", ...)` | 仅 macOS | 语音 gate |
| `scripts/build-desktop.sh:147-156` | PlistBuddy、codesign | 仅 macOS | 仅在 darwin 执行 |
| `scripts/install-desktop.sh`、`make-dmg.sh`、`uninstall-desktop.sh` | `/Applications`、`pkill`、codesign | 仅 macOS | 保留；新增平台安装说明/脚本 |
| `scripts/gen-icons.mjs` | 只产出 macOS iconset、36px 托盘图 | Windows/Linux 图标缺失 | 增加 `desktop/icon.png` 与平台托盘图 |
| `desktop/electrobun.config.ts` | 只有 `mac` 配置 | Windows/Linux 用默认图标 | 增加 `win.icon`、`linux.icon` |

另有两处硬编码需要直接删除，而不是平台分支：

- `desktop/src/bun/index.ts:23` 的 `FALLBACK_REPO_ROOT = "/Users/dev/..."`：打包后不应依赖开发机路径。改为「未设置 `MO_AGENT_ROOT` 且找不到 runtime 时明确报错」，开发态必须显式设置 `MO_AGENT_ROOT`。
- `desktop/src/bun/index.ts:321` 的 PATH 拼接：非 Windows 追加 homebrew 路径；Windows 不追加，改为 `%ProgramFiles%\nodejs`、`%APPDATA%\npm` 等。

## 3. 路径规范（核心）

### 3.1 两类路径必须分开

| 类别 | 内容 | 策略 |
|---|---|---|
| 用户数据 | 配置、设备令牌、本机 session、语音开关、浮层位置、推送 token、通知配置 | **三平台统一在 `~/.mo-agent`**（可用 `MO_AGENT_HOME` 覆盖） |
| 系统数据 | 安装后的 runtime、日志、WebView 缓存、临时文件 | 按平台惯例放系统目录 |

理由：

- `~/.mo-agent` 是 Agent hook、CLI、文档已经约定的契约；换到 `%APPDATA%` 会让 Windows 上的 hook 命令、用户排障路径与 macOS 不一致。
- Windows 的 `~` 在 Node 里由 `os.homedir()` 解析为 `%USERPROFILE%`（不是 Git Bash 的 `$HOME`），GUI 与 CLI 能对齐。
- 系统目录（runtime/logs）体积大、可重建，放 `LocalAppData`/`XDG` 更符合平台规范，也避免用户把 `.mo-agent` 当配置目录备份时把 300MB runtime 一起带走。

### 3.2 目录矩阵

| 用途 | macOS | Windows | Linux |
|---|---|---|---|
| 用户数据 | `~/.mo-agent` | `%USERPROFILE%\.mo-agent` | `~/.mo-agent` |
| runtime | `~/Library/Application Support/mo-agent/runtime` | `%LOCALAPPDATA%\mo-agent\runtime` | `$XDG_DATA_HOME/mo-agent/runtime`（默认 `~/.local/share/...`） |
| 日志 | `~/Library/Logs/mo-agent` | `%LOCALAPPDATA%\mo-agent\logs` | `$XDG_STATE_HOME/mo-agent/log`（默认 `~/.local/state/...`） |
| WebView 缓存 | `~/Library/Application Support/dev.moagent.desktop` | `%APPDATA%\dev.moagent.desktop` | `$XDG_CONFIG_HOME/dev.moagent.desktop` |
| 安装位置 | `/Applications/mo-agent.app` | `%LOCALAPPDATA%\Programs\mo-agent`（安装器决定，需实测） | AppImage 所在目录 / `~/.local/bin` |
| 临时文件 | `os.tmpdir()` | `%TEMP%` | `os.tmpdir()` |

> 注：Windows 的 WebView2 用户数据目录最终由 Electrobun/WebView2 决定，表中是清理与排障用的预期值；以实际安装后目录为准。

### 3.3 统一解析器 API

新增 `core/platform-paths.mjs`（纯函数，**不直接读全局**，方便在 macOS 上单测 Windows 路径）：

```js
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function expandPath(value, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (!value) return value;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  let text = String(value);
  if (text === "~") text = home;
  else if (text.startsWith("~/") || text.startsWith("~\\")) text = pathImpl.join(home, text.slice(2));
  // Windows 风格 %VAR%；未定义的变量保持原样，避免静默指到错误目录
  text = text.replace(/%([^%]+)%/g, (all, name) => env[name] ?? env[name.toUpperCase()] ?? all);
  // 只展开 HOME，其他 $VAR 不碰（避免误伤价格、命令替换里的 $）
  text = text.replace(/\$HOME/g, home);
  return pathImpl.resolve(text);
}

export function resolvePlatformPaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const isWin = platform === "win32";
  const isMac = platform === "darwin";
  const resolve = (value) => expandPath(value, { platform, env, home });
  const join = (...parts) => pathImpl.join(...parts);
  const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const roamingAppData = env.APPDATA || join(home, "AppData", "Roaming");
  const xdgData = env.XDG_DATA_HOME || join(home, ".local", "share");
  const xdgState = env.XDG_STATE_HOME || join(home, ".local", "state");
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config");

  const userDataDir = resolve(env.MO_AGENT_HOME || join(home, ".mo-agent"));
  const runtimeRoot = resolve(env.MO_AGENT_RUNTIME_DIR || (isMac
    ? join(home, "Library", "Application Support", "mo-agent", "runtime")
    : isWin
      ? join(localAppData, "mo-agent", "runtime")
      : join(xdgData, "mo-agent", "runtime")));
  const logDir = resolve(env.MO_AGENT_LOG_DIR || (isMac
    ? join(home, "Library", "Logs", "mo-agent")
    : isWin
      ? join(localAppData, "mo-agent", "logs")
      : join(xdgState, "mo-agent", "log")));

  return {
    platform,
    home,
    userDataDir,
    runtimeRoot,
    logDir,
    logFile: resolve(env.MO_AGENT_LOG_FILE || join(logDir, "host.log")),
    desktopLogFile: join(logDir, "desktop.log"),
    sessionFile: join(userDataDir, "session.json"),
    devicesFile: resolve(env.MO_AGENT_DEVICE_FILE || join(userDataDir, "devices.json")),
    notifyFile: resolve(env.MO_AGENT_NOTIFY_FILE || join(userDataDir, "notify.json")),
    pushTokensFile: join(userDataDir, "push-tokens.json"),
    voiceConfigFile: join(userDataDir, "voice.json"),
    voiceOverlayFile: join(userDataDir, "voice-overlay.json"),
    lockFile: join(userDataDir, "desktop.lock"),
    launchFile: join(userDataDir, "desktop.launch"),
    webviewDataDir: isMac
      ? join(home, "Library", "Application Support", "dev.moagent.desktop")
      : isWin
        ? join(roamingAppData, "dev.moagent.desktop")
        : join(xdgConfig, "dev.moagent.desktop"),
  };
}

export function toFileUrl(file) {
  return pathToFileURL(file).href;
}
```

落地约束：

1. **所有路径都用 `path.join/resolve`，不做字符串拼接**；SQLite、transcript 的展示路径可以统一转 `/`，但写盘必须用平台路径。
2. **比较路径时 Windows 不区分大小写**：需要去重/判断相等时，Windows 分支先 `toLowerCase()`；不要用字符串前缀判断。
3. **环境变量优先级**：显式 `MO_AGENT_*` > 平台默认。保留现有 `MO_AGENT_LOG_FILE`、`MO_AGENT_DEVICE_FILE`、`MO_AGENT_ROOT` 的语义。覆盖值建议写绝对路径；相对路径按当前工作目录解析，容易因启动方式不同而漂移。
4. **路径里的非 ASCII**（中文用户名、张三）必须按 UTF-8 写 JSON；不要用 `latin1` 读写配置。
5. **空目录自动创建**：`ensureDir` 在 Windows 同样有效；`chmod` 在 Windows 是 no-op，必须用 try/catch 或平台判断，不能因为 chmod 失败中断启动。
6. **桌面壳的引用方式**：`desktop/src/bun/index.ts` 相对 import `core/platform-paths.mjs`，由 Electrobun 打包时内联；不要指望壳启动时磁盘上存在 `runtime/core/`。host 运行时仍然复制 `core/`，因为它动态加载适配器。

### 3.4 `~/.mo-agent` 的兼容与迁移

- macOS/Linux 保持原路径，零迁移。
- Windows 首次启动创建 `%USERPROFILE%\.mo-agent`；其下文件名与 macOS 完全一致（`session.json`、`devices.json`、`notify.json`、`voice.json`、`push-tokens.json`、`desktop.lock`）。
- 如果用户设了 `MO_AGENT_HOME`，host、桌面壳、hook CLI 三处必须解析到同一目录；**hook 子进程不会继承桌面壳的临时环境变量**，所以不要在桌面壳里临时改 `MO_AGENT_HOME` 而不写进 hook 命令。推荐：需要自定义目录时，在用户环境变量里设置，或把绝对路径写进 hook 命令。
- Windows 的 dotfile 不会自动隐藏（不像 `.config` 在 Finder 里默认隐藏），文档里给出完整路径即可，不额外加隐藏属性。
- 安全：`session.json` 含本机令牌。Windows 上 `mode: 0o600` 只影响创建权限位，实际 ACL 继承用户目录；当前阶段可接受，后续可用 `icacls` 收紧。不要把 `.mo-agent` 放到共享目录。

### 3.5 WSL / Git Bash 边界

- 在 WSL 里跑的 Claude Code/Codex，配置在 WSL 的 `/home/<user>/.claude`，Windows 侧 `C:\Users\<user>\.claude` 看不到。
- 在 Git Bash 里启动 mo-agent 时，`os.homedir()` 仍返回 Windows 用户目录（Node 行为），不要用 shell 的 `$HOME` 推导。
- 明确写入文档：**mo-agent 只管理当前 Windows 用户原生安装的 Agent；WSL/远程 Agent 不支持**。

## 4. Agent 路径差异

### 4.1 总表

| Agent | 配置 / hook 文件 | transcript / 会话根 | Windows | Linux | 备注 |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | `~/.claude/projects` | `%USERPROFILE%\.claude\...` | `~/.claude/...` | Windows 原生版路径一致；hook 的 shell 需实测 |
| Codex CLI | 暂无托管 hook | `~/.codex/sessions` | `%USERPROFILE%\.codex\sessions` | `~/.codex/sessions` | 未启用 |
| Gemini CLI | 暂无托管 hook | `~/.gemini` | `%USERPROFILE%\.gemini` | `~/.gemini` | 未启用 |
| Qoder CN | `~/.qoder-cn/settings.json` | `~/.qoder-cn/projects` | `%USERPROFILE%\.qoder-cn\...` | `~/.qoder-cn/...` | 标题库/IDE 目录另算，见 4.3 |
| WorkBuddy | `~/.workbuddy/settings.json` | `~/.workbuddy/projects` | 先按 `%USERPROFILE%\.workbuddy`，待实测 | `~/.workbuddy/...` | 若厂商改用 `%APPDATA%`，用 profile 覆盖 |
| DeepSeek Harness | 原生接入，无 hook 文件 | `~/.dsh/oh-my-dsh/shell/dsh-web.json` | `%USERPROFILE%\.dsh\...` | `~/.dsh/...` | 支持 `DSH_HOME` 覆盖 |

> 表中「待实测」表示没有在目标系统上验证过厂商的 userData 规则，不能当作已实现。实现时先用 profile 的平台映射兜底，并在目标机确认。

### 4.2 profile 增加平台映射

保留现有字符串写法（向后兼容），新增可选字段：

```json
{
  "session": {
    "kind": "jsonl-transcript",
    "root": "~/.qoder-cn/projects",
    "platformRoots": {
      "win32": "%USERPROFILE%\\.qoder-cn\\projects",
      "linux": "~/.qoder-cn/projects"
    }
  },
  "hooks": {
    "kind": "qoder-cn",
    "settingsFile": "~/.qoder-cn/settings.json",
    "settingsFilesByPlatform": {
      "win32": ["%USERPROFILE%\\.qoder-cn\\settings.json"],
      "linux": ["~/.qoder-cn/settings.json"]
    },
    "shell": "auto",
    "nodePath": "auto"
  }
}
```

解析优先级：

1. 环境变量（`MO_AGENT_CLAUDE_ROOT`、`MO_AGENT_QODER_CN_ROOT`、`MO_AGENT_WORKBUDDY_ROOT` 等）；
2. `platformRoots[process.platform]` / `settingsFilesByPlatform[process.platform]`；
3. 字符串字段 `root` / `settingsFile`；
4. 适配器默认值。

实现要求：

- `expandPath` 处理 `~`、`%VAR%`、`$HOME`；Windows 环境变量名大小写不敏感。
- `loadProfiles` 返回原始 profile，由 `createAdapters` / `hooksManager` 在各自平台解析；不要在 registry 里提前展开成某台机器的绝对路径。
- 所有路径字段在 JSON 里用双反斜杠转义；写入 hook 命令时由 `JSON.stringify` 负责转义，不要再手工拼接反斜杠。

### 4.3 Qoder CN 的额外路径

当前实现只认 macOS：

| 数据 | macOS | Windows（待实测） | Linux（待实测） |
|---|---|---|---|
| 会话 SQLite | `~/Library/Application Support/com.qodercn.app.stable/main.sqlite` | `%APPDATA%\com.qodercn.app.stable\main.sqlite` | `$XDG_CONFIG_HOME/com.qodercn.app.stable/main.sqlite` |
| IDE workspaceStorage | `~/Library/Application Support/QoderCN/User/workspaceStorage` | `%APPDATA%\QoderCN\User\workspaceStorage` | `$XDG_CONFIG_HOME/QoderCN/User/workspaceStorage` |
| sqlite3 CLI | `/usr/bin/sqlite3`、`/opt/homebrew/bin/sqlite3` | `%ProgramFiles%\sqlite3\sqlite3.exe`、PATH | `/usr/bin/sqlite3`、`/snap/bin/sqlite3` |

降级策略：读不到标题库或没有 sqlite3 时，不报错、不阻塞会话列表，标题退回「第一问截断」。Windows 上优先尝试 `node:sqlite`（Node 22.5+）或 `bun:sqlite`（如果运行时支持），再退回 CLI。

### 4.4 Hook 命令的可移植性

这是跨平台最容易静默失败的一处。现状 `hookCommandFor` 固定生成：

```text
"node" "/path/to/approvals/hook-cli.mjs" event PermissionRequest claude-code
```

Windows 上要解决三件事：

1. **node 可执行文件**：不能写裸 `node`，要从绝对路径解析（桌面从开始菜单启动时 PATH 可能不完整）。
2. **路径引号**：路径可能含空格、中文、`&`；统一用双引号包裹每个路径。
3. **执行 shell**：Agent 在 Windows 上可能用 `cmd.exe`、PowerShell 或 Git Bash，三者对「带引号的命令」解析不同。

建议 profile 增加 `hooks.shell`：

| 值 | 生成的命令形态 | 适用 |
|---|---|---|
| `posix` | `"node" "cli.mjs" event ...` | macOS / Linux / Git Bash |
| `cmd` | `"C:\Program Files\nodejs\node.exe" "C:\...\hook-cli.mjs" event ...` | cmd.exe |
| `powershell` | `& "C:\Program Files\nodejs\node.exe" "C:\...\hook-cli.mjs" event ...` | PowerShell |

默认：macOS/Linux 用 `posix`；Windows 先按 `cmd`，每个 Agent 在真机确认后再改。**未确认的 Agent 不启用写 hook**，设置页显示「Windows 待验证」，避免写出一条永远不触发的命令。

node 解析顺序（Windows）：

1. `MO_AGENT_NODE`（存在且是文件）；
2. `process.execPath`，且 basename 是 `node.exe`（排除 `mo-agent-host.exe`）；
3. `PATH` 各项下的 `node.exe`（用 `path.delimiter` 拆分）；
4. `%ProgramFiles%\nodejs\node.exe`、`%ProgramFiles(x86)%\nodejs\node.exe`；
5. `%LOCALAPPDATA%\Programs\nodejs\node.exe`；
6. nvm-windows：`%NVM_HOME%\node.exe`、`%APPDATA%\nvm\v*\node.exe`；
7. Volta：`%LOCALAPPDATA%\Volta\bin\node.exe`；
8. fnm：`%APPDATA%\fnm\node-versions\*\installation\node.exe`；
9. Scoop：`%USERPROFILE%\scoop\shims\node.exe`；
10. 最后才回退 `where node` 的结果。

macOS/Linux 保留现有顺序，补充 `/usr/bin/node`、`/snap/bin/node`、`~/.asdf/shims/node`。

写 hook 的原子性与备份：

- `writeSettings` 在 Windows 上 `renameSync(tmp, file)` 可能因为 Agent 正打开配置而 `EPERM`；加重试（3 次，100/300/900ms），仍失败则明确报错并保留备份。
- `backup` 文件名已去掉冒号，Windows 合法；保留 `.mo-agent.bak-<timestamp>` 后缀。
- `chmodSync` 在 Windows 包 try/catch；不要因为权限位失败回滚已写入的配置。

### 4.5 进程发现

`adapters/process-scan.mjs` 当前只跑 `ps`，Windows 上直接返回空，表现为「托盘正常但看不到任何 Agent」。

| 平台 | 命令 | 说明 |
|---|---|---|
| macOS/Linux | `ps -axo pid=,ppid=,etime=,command=` | 保持现状 |
| Windows | PowerShell `Get-CimInstance Win32_Process` | 取 `ProcessId`、`ParentProcessId`、`CreationDate`、`CommandLine`，转 JSON |

建议命令：

```powershell
[Console]::OutputEncoding=[Text.Encoding]::UTF8;
Get-CimInstance Win32_Process |
  Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine |
  ConvertTo-Json -Compress
```

要求：

- `execFile` 调用 `powershell.exe`（或 `pwsh.exe`，先探测），加 `-NoProfile -NonInteractive`，超时 5-10 秒；失败时降级为空列表并打日志，不阻塞 host。
- 命令输出按 UTF-8 解码；Windows 中文系统默认代码页不是 UTF-8，所以命令里显式设置 `OutputEncoding`。
- 把 `command` 里的反斜杠统一成 `/` 再匹配现有正则，这样 `(^|/)claude` 这类 profile 不用全部重写；同时允许 `.exe`/`.cmd` 后缀。
- `elapsed` 用 `CreationDate` 与当前时间计算成人类可读字符串（或保留秒数，前端只展示）。
- 过滤自身：匹配 `process-scan` 时同时匹配 `powershell` + `Win32_Process`，避免把扫描进程当成 Agent。
- 若 PowerShell 被策略禁用，可退回 `tasklist /FO CSV /NH`；但 tasklist 没有命令行，只能按镜像名匹配，需在 profile 增加 `process.matchName`，并接受能力降级。

### 4.6 其他分隔符问题

- `adapters/qoder-cn.mjs:41`：改为 `/[\\/]transcript[\\/]/.test(st.path)`，或统一 `st.path.split(path.sep)`。
- `adapters/dsh-monitor.mjs:266`：改为 `path.basename(item.cwd)`（先 `import path from "node:path"`）。
- `adapters/transcript-adapter.mjs` 的 `expandHome`：改用 `core/platform-paths.mjs` 的 `expandPath`，支持 `%VAR%` 和 Windows 反斜杠。
- 所有 `startsWith("~")` 的地方检查一次，避免把 Windows 的 `~foo` 误展开。

## 5. 桌面壳改造

### 5.1 新增平台模块

建议 `desktop/src/bun/platform.ts`：

```ts
export const PLATFORM = process.platform === "darwin" ? "macos"
  : process.platform === "win32" ? "win" : "linux";
export const IS_MAC = PLATFORM === "macos";
export const IS_WIN = PLATFORM === "win";
export const IS_LINUX = PLATFORM === "linux";
```

所有平台判断集中在这里，禁止在业务代码里散落 `process.platform === "darwin"`。

### 5.2 能力矩阵

| 能力 | macOS | Windows | Linux |
|---|---|---|---|
| 托盘图标 | 36×36 单色 template PNG | 32×32 PNG（非 template） | 32×32 PNG；依赖 AppIndicator |
| Dock | `setDockIconVisible(false)` + LSUIElement | 不适用 | 不适用 |
| 应用菜单 | `ApplicationMenu`（Escape 关闭） | 只用托盘菜单 | 只用托盘菜单；可选原生菜单 |
| 全局快捷键 | Carbon 优先，失败回退 GlobalShortcut | GlobalShortcut | GlobalShortcut；Wayland 可能不可用 |
| 设置窗口 | 普通 BrowserWindow | 普通 BrowserWindow | 普通 BrowserWindow |
| 语音浮层/浮球 | AppKit styleMask | P5 前不创建 | P5 前不创建 |
| 麦克风设置 | `x-apple.systempreferences:...` | `ms-settings:privacy-microphone` | 无统一入口，弹说明 |
| 再次启动 | `app.on("reopen")` + 单实例请求文件 | 单实例请求文件 | 单实例请求文件 |
| 退出 | kill host child | `taskkill /pid /T /F` 兜底 | kill host child |

实现要点：

- `Utils.setDockIconVisible`、`ApplicationMenu`、`ensureCarbonHotkey`、`registerCarbonHotkey`、`unregisterCarbonHotkey`、`checkAccessibilityTrust` 只允许在 `IS_MAC` 分支调用；不要只靠 try/catch，非 macOS 上不应加载 Carbon dylib。
- `panel` 窗口的 `keyDown` 里 `keyCode === 53` 是 macOS Escape 键码；非 macOS 不要依赖它，交给页面 `keydown` 处理。
- `setVisibleOnAllWorkspaces` 仅在 macOS 调用；Windows/Linux 忽略。
- 托盘 `template` 只在 macOS 设 `true`；Windows/Linux 用彩色/非模板图。
- `Tray` 创建失败（Linux 没有 AppIndicator）时，不能静默；至少写日志并在设置窗口里给出安装提示（`libayatana-appindicator3` / GNOME 扩展）。

### 5.3 运行时安装与解包

现状 `ensureRuntime` 逻辑在 macOS 可用，Windows 需要处理：

1. **可执行文件名**：`bin/mo-agent-host.exe`；`packaged` 判断和 spawn 都要带后缀。
2. **权限**：Windows 不需要 `chmod`；不要对 `.exe` 调 `chmodSync`（虽然 no-op，但不必要）。
3. **解包工具**：优先系统 `tar`。Windows 10 1809+ 自带 `C:\Windows\System32\tar.exe`；若不存在，用内置 `zlib.gunzipSync` + 一个最小 ustar 解包器（runtime 包内路径都很短），不要引入 7-Zip 外部依赖。
4. **文件占用**：Windows 上正在运行的 `mo-agent-host.exe` 不能被覆盖。采用**版本化 runtime**：
   ```text
   %LOCALAPPDATA%\mo-agent\runtime\<version>-<arch>\
   %LOCALAPPDATA%\mo-agent\runtime\current.json   // { version, path }
   ```
   新版本解压到新目录，写 `current.json` 后杀旧 host；旧目录启动时清理（删除失败就留着，不阻塞）。
5. **校验**：`runtime.json` 增加 `platform`、`arch`、`voice` 字段；启动时校验，防止把 macOS runtime 拷到 Windows 上运行。版本相同且 platform/arch 匹配才复用。
6. **payload 定位**：`runtimePayloadTar()` 增加平台候选：
   - macOS：现有 `Contents/Resources/app/runtime.tar.gz`；
   - Windows/Linux：`<app>/resources/app/runtime.tar.gz`、`<app>/Resources/app/runtime.tar.gz`、`process.cwd()/app/runtime.tar.gz`；
   - 统一支持 `MO_AGENT_RUNTIME_TAR` 覆盖，便于排障。

macOS 保持现有 `~/Library/Application Support/mo-agent/runtime` 不变，避免升级迁移；Windows/Linux 从第一天就用版本化目录。等 Windows/Linux 稳定后，再考虑把 macOS 也切到版本化（另立任务）。

### 5.4 单实例

现状用 `linkSync` 硬链接创建锁文件；Windows 的 NTFS 支持硬链接，但 exFAT、部分网络盘、受限环境可能失败。改为：

```ts
const fd = openSync(lockPath, "wx", 0o600); // O_CREAT | O_EXCL，原子
writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }));
closeSync(fd);
```

- 锁已存在时读 PID；`process.kill(pid, 0)` 在 Windows 上可用（`EPERM` 视为存活，`ESRCH` 视为已退出）。
- 清理陈旧锁前先确认 PID 不存在；删除失败（Windows 文件被占用）就重试几次，仍失败则写启动请求并退出，避免双托盘。
- 请求文件轮询 200ms 保持现状；Windows 上文件写入后立即可见，无额外处理。
- 退出时只删除自己 token 的锁（现状已正确），保留。

### 5.5 子进程与环境

- spawn host 加 `windowsHide: true`，避免弹出控制台窗口；`stdio: "ignore"` 保持不变。
- PATH 拼接统一用 `path.delimiter`：
  - macOS：追加 `/opt/homebrew/bin`、`/usr/local/bin`；
  - Windows：追加 `%ProgramFiles%\nodejs`、`%APPDATA%\npm`、`%LOCALAPPDATA%\Programs\nodejs`（存在的才加）；
  - Linux：追加 `/usr/local/bin`、`/snap/bin`。
- `restartService` / 退出：先 `host.kill()`，等 300-500ms；Windows 若进程树残留，用 `taskkill /pid <pid> /T /F` 兜底（`execFile` 调用，捕获错误）。
- 打开日志目录：`Utils.openPath(LOG_DIR)` 三平台可用；不要用 `file://` 字符串。需要打开日志文件时用 `pathToFileURL`。
- 打开麦克风设置：macOS 现有 URL；Windows `ms-settings:privacy-microphone`；Linux 不猜桌面环境，弹 `showMessageBox` 给出手动路径。

## 6. Host 改造

- `host/index.mjs`：`logFile`、`deviceFile`、`writeSessionFile`、voice 配置路径全部改用 `resolvePlatformPaths`。
- `host/notify-webhook.mjs`、`host/push-tokens.mjs`、`host/notify-config.mjs`、`host/voice/helper-client.mjs`、`approvals/hook-cli.mjs`：默认路径统一走 resolver；保留各自的 `opts.file` / 环境变量覆盖。
- `host/config.mjs`：`dshHome` 用 `expandPath(process.env.DSH_HOME || "~/.dsh")`。
- `host/voice/`：增加平台 gate：
  - `MO_AGENT_VOICE=1` 在非 darwin 上记录 warn 并视为关闭；
  - `checkVoiceReady` 返回 `voice-unsupported`，不要让菜单/HTTP 端点崩溃；
  - 桌面托盘在非 macOS 不显示语音子菜单。
- `host/index.mjs` 的 `writeSessionFile`：Windows 上 `mode` 无效，但目录创建、UTF-8 写入、覆盖写保持不变；`chmod` 包 try/catch（现状已有）。
- `host/http.mjs` 的 `localIPv4List`：`os.networkInterfaces()` 跨平台可用；Windows 上可能返回虚拟网卡（WSL/Hyper-V/VPN），建议文档提示用户先选正确网卡，不急着过滤。
- 日志轮转：Windows 上 `renameSync` 可能被日志查看器占用；`rotateLog` 每次 rename 包 try/catch（现状已有），失败就继续写当前文件，不阻塞。

## 7. 构建与分发

### 7.1 为什么必须原生构建

`desktop/.hutch/dependencies.lock` 里锁定的是：

```json
{ "relativeRoot": "releases/electrobun/2.0.2/macos-arm64", "platform": "macos-arm64" }
```

Hutch 按当前平台选择 Electrobun devkit；cottontail 主进程、launcher、原生库也是平台相关的。因此：

- 不能在 macOS 上 `hutch run build` 产出 Windows/Linux 包；
- 也不要尝试只替换 `runtime.tar.gz` 来「伪跨平台」；
- CI 用三个 OS 的 runner 各自构建。

### 7.2 构建脚本

建议把逻辑收敛到 `scripts/build-desktop.mjs`（Node ESM，三平台可跑），`scripts/build-desktop.sh` 只做兼容包装（转调 Node），避免 Bash/PowerShell 两套逻辑漂移。

步骤：

1. 定位 `bun`（`BUN` 环境变量 > PATH > `~/.bun/bin/bun`）；Windows 用 `bun.exe`。
2. 编译 host：
   ```bash
   bun build host/index.mjs --target=bun --compile --outfile desktop/runtime/bin/mo-agent-host[.exe]
   ```
   **必须在目标 OS 上执行**，不要依赖 Bun 的交叉编译。
3. 组装 runtime：`app/web`、`adapters/*.mjs`、`adapters/profiles`、`core/*.mjs`、`approvals/*.mjs`、`host/notify-defaults.json`、可选 APK。
4. 语音资源：仅 `darwin` 且 `WITH_VOICE=1` 时复制 `.build/mo-agent 语音.app`、`whisper-cli`、模型；其他平台跳过并写 `runtime.json.voice=false`。
5. 写 `runtime.json`：`{ version, builtAt, platform, arch, voice }`。
6. 打 `desktop/runtime.tar.gz`：优先系统 `tar`；Windows 用 `tar.exe`；若没有，用 Node `zlib` + tar 写入（或直接复制目录并用内置解包器）。
7. 执行 `hutch install` / `hutch run build`。Windows 上 `hutch` 可能是 `.cmd`，Node `spawn` 需要 `shell: true` 或显式解析 `.cmd`。
8. 平台后处理：
   - macOS：PlistBuddy 写 `LSUIElement`、麦克风用途说明、ad-hoc `codesign`；
   - Windows：可选 Authenticode 签名（P4 不做），校验 `-Setup.exe`；
   - Linux：校验 AppImage 可执行位。
9. 产物校验：
   - runtime 里存在 `bin/mo-agent-host[.exe]`、`app/web/index.html`、`adapters/profiles/*.json`、`approvals/hook-cli.mjs`；
   - 构建目录符合 `stable-<os>-<arch>`；
   - 更新包与 `*-update.json` 存在；
   - 发布目录里的安装包/可执行文件名已带上 `<version>-<os>-<arch>`，且版本号与 `package.json` / `electrobun.config.ts` 一致。

保留环境变量：`WITH_VOICE`、`BUN`、`HUTCH_HOME`、`MO_AGENT_ROOT`。

### 7.3 产物矩阵

Electrobun 2.0.2 的原始命名（`api/shared/naming.ts`）**不含版本号和架构**：`mo-agent-Setup.exe`、`mo-agent-Setup.AppImage`、`mo-agent.app.tar.zst`。因此由 `scripts/build-desktop.mjs` 在 Electrobun 构建完成后**复制/改名到发布目录**，不要直接改 Electrobun 的内部文件名，否则 `*-update.json` 里的 `url` 与哈希会对不上，自动更新失败。

发布命名格式：

```text
mo-agent-<version>-<os>-<arch>-<kind>.<ext>
```

- `version`：取自 `package.json` 的 `version`；构建时校验它与 `desktop/electrobun.config.ts` 的 `app.version` 一致，避免两处版本漂移。
- `os`：`macos` / `win` / `linux`。
- `arch`：`arm64` / `x64`。
- `kind`：`zip`、`dmg`、`Setup`、`portable`、`app` 等；只有分发文件带版本/架构，应用包内部的 `mo-agent.app`、安装目录里的 `mo-agent.exe` 保持原名（改名会破坏 bundle 结构、快捷方式和签名）。

| 目标 | build 目录 | 发布安装包 / 可执行（含版本+架构） | 应用主体 | 发布更新包（含版本+架构） |
|---|---|---|---|---|
| macOS arm64 | `stable-macos-arm64` | `mo-agent-0.2.0-macos-arm64.zip`（或 `.dmg`；内含 `mo-agent.app`） | `mo-agent.app` | `mo-agent-0.2.0-macos-arm64.app.tar.zst` |
| macOS x64 | `stable-macos-x64` | `mo-agent-0.2.0-macos-x64.zip`（或 `.dmg`） | `mo-agent.app` | `mo-agent-0.2.0-macos-x64.app.tar.zst` |
| Windows x64 | `stable-win-x64` | `mo-agent-0.2.0-win-x64-Setup.exe`；可选便携包 `mo-agent-0.2.0-win-x64-portable.zip` | 安装目录内 `mo-agent.exe` | `mo-agent-0.2.0-win-x64.tar.zst` |
| Linux x64 | `stable-linux-x64` | `mo-agent-0.2.0-linux-x64-Setup.AppImage` | AppImage 本身（内部原名不对外） | `mo-agent-0.2.0-linux-x64.tar.zst` |

> 具体子目录名以 Electrobun 实际产物为准；脚本用 `build/stable-<os>-<arch>` 做目标目录，而不是写死 `stable-macos-arm64`。

**更新包的双命名**：Electrobun 的 `stable-<os>-<arch>-update.json` 默认引用原始 `mo-agent.tar.zst` / `mo-agent.app.tar.zst`。两者只能选一种策略：

1. **推荐：更新链路保持原名。** `artifacts/` 内保留 Electrobun 原始文件名供 `update.json` 使用；`dist/` 里另放带版本+架构的副本供用户下载。这样自动更新不依赖改名逻辑。
2. **版本化更新包：** 同时改写 `update.json` 的 `url` 和哈希，并补一次完整升级回归；不能只改文件名不改 JSON。

发布页/对象存储以 `dist/` 为准；CI 至少上传 `dist/` 和 `artifacts/` 两部分，便于排查「用户下载的名字」与「更新器引用的名字」不一致。

### 7.4 图标与托盘资源

`scripts/gen-icons.mjs` 增加：

- `desktop/icon.png`（1024×1024，来自 `svgSquircle`）→ `linux.icon` / `win.icon`；
- `desktop/src/mainview/tray-win.png`（32×32，非 template）；
- `desktop/src/mainview/tray-linux.png`（32×32 或 24×24）；
- 保留 macOS `icon.iconset` 与 36×36 `tray.png`。

Electrobun 配置：

```ts
build: {
  mac: { bundleCEF: false, createDmg: false, icons: "icon.iconset" },
  win: { bundleCEF: false, icon: "icon.png" },
  linux: { bundleCEF: false, icon: "icon.png" },
}
```

Windows 的 `icon` 接受 PNG，Hutch 会转 ICO；如果实际构建不支持，再补生成 `icon.ico`（多尺寸 16/32/48/256），不要临时手写二进制。

### 7.5 CI 矩阵

建议 `.github/workflows/desktop.yml`（P4 实现）：

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - os: macos-14
        target: macos-arm64
      - os: macos-13
        target: macos-x64
      - os: windows-2022
        target: win-x64
      - os: ubuntu-22.04
        target: linux-x64
```

每个 job：

1. checkout；
2. 安装 Node 22、Bun 1.3+；
3. 安装/缓存 Hutch（`HUTCH_HOME` 指向工作区或缓存目录）；
4. `node scripts/build-desktop.mjs`；
5. 运行 `npm test`（纯逻辑测试在任何平台都能跑）；
6. 上传 `desktop/build/stable-<target>`、`desktop/artifacts` 和 `dist/`（版本化发布名与更新器原名分开，见 7.3）。

注意：

- macos-13 是 x64 runner；不要用 arm64 runner 交叉出 x64。
- Linux 用 Ubuntu 22.04 构建，兼容 glibc 2.35 基线；不要在 24.04 上构建后再声称支持 22.04。
- Windows job 用 `pwsh`，但构建脚本保持 Node 跨平台，不写 PowerShell 业务逻辑。
- 缓存 `desktop/.hutch` 与 `~/.bun` 可显著减少时间；不要把 `runtime.tar.gz` 缓存进 git。

### 7.6 签名与分发

- macOS：继续 ad-hoc；正式 Developer ID + notarization 另立任务。
- Windows：未签名会触发 SmartScreen；文档写清「更多信息 → 仍要运行」。正式发布前申请 Authenticode 证书并时间戳。
- Linux：AppImage 不强制签名；可在发布页附 SHA256。首次运行需要 `chmod +x`；缺少 FUSE 时用 `--appimage-extract-and-run`。
- 用户数据不随卸载删除；卸载说明里给出 `~/.mo-agent` 与平台日志/runtime 目录的清理命令（让用户自己决定）。

## 8. 分阶段落地

### P0 文档（本次）

- 本文落库，README 增加入口。
- 不改代码，不改变现有 macOS 构建。

**验收**：文档中的路径矩阵与代码现状一致；所有「待实测」项有明确验证方法。

### P1 路径抽象（不改行为）

- 新增 `core/platform-paths.mjs` + `core/platform-paths.test.mjs`（用注入的 platform/env/home 跑 macOS/Windows/Linux 三组断言）。
- host、桌面壳、hook CLI 替换散落的 `.mo-agent`、`Library/...` 路径。
- 保留所有现有环境变量覆盖；macOS 解析结果必须与改动前逐字节一致（用测试固定）。

**验收**：macOS 构建/启动/日志/面板行为不变；`grep` 不再有未 gate 的 `Library/` 路径。

### P2 Windows 桌面壳

- `desktop/src/bun/platform.ts`；Carbon/ApplicationMenu/Dock/reopen 全部 gate。
- 运行时 `.exe`、解包、版本化目录、单实例 `wx`、spawn `windowsHide`、PATH、file URL、设置入口。
- 托盘图标与 `win.icon`。
- 语音菜单在 Windows 隐藏。

**验收**：Windows 11 x64 上安装未签名包，托盘出现；设置面板、`/agents`、hook 写入、重启、日志、单实例、局域网配对各跑一次。

### P3 Linux 桌面壳

- 同上平台 gate；Linux 托盘/AppIndicator、图标、路径。
- Wayland 下全局快捷键/浮层定位的降级说明；语音仍不做。
- 首次运行依赖检查文档（WebKitGTK、AppIndicator）。

**验收**：Ubuntu 22.04/24.04 x64 上 AppImage 可启动；X11 下托盘菜单、设置面板、日志、hook、配对可用；GNOME 无扩展时给出明确提示。

### P4 Agent 路径与 hook 可移植

- profile 平台映射；`expandPath` 支持 `%VAR%`。
- `resolveNodePath` Windows 分支；`hooks.shell` 三模板；hook 写入重试。
- `process-scan` Windows PowerShell + 降级。
- Qoder 标题库/IDE 路径、`labelFor`、DSH basename。
- 目标机实测 Claude Code / Qoder CN / WorkBuddy 的 hook 是否触发；未验证的 Agent 在设置页标记「Windows 待验证」，不写 hook。

**验收**：Windows 上至少 Claude Code（或 Qoder CN）完成一次「权限请求 → 手机批准」闭环；Linux 上 transcript 观测正常。

### P5 构建/CI/分发

- `scripts/build-desktop.mjs` 三平台；macOS 脚本包装；
- CI 矩阵；图标；Windows/Linux 安装说明；
- 更新包/JSON 按平台产出（发布服务端另接）。

**验收**：CI 一次产出四个目标（mac arm64/x64、win x64、linux x64）；每类产物可安装启动。

### P6 语音（另立）

- Windows：WASAPI/WebAudio + 系统 TTS/本地 ASR；Linux：PipeWire/PulseAudio + 可选 whisper。
- 在完成前，托盘不显示语音入口，文档明确「macOS only」。

## 9. 验收清单

### 9.1 Windows 11 x64

- [ ] `mo-agent-Setup.exe` 安装/卸载；开始菜单/托盘图标正常。
- [ ] 首次启动创建 `%USERPROFILE%\.mo-agent`，`session.json` 可被 hook CLI 读到。
- [ ] 托盘菜单：设置、一键配置、重启、日志、退出；无语音项。
- [ ] 设置面板加载 `/setup`，二维码可被手机扫描；防火墙允许专用网络后局域网可访问。
- [ ] `/agents` 正确列出 Agent；hook 写入 `%USERPROFILE%\.claude\settings.json`（或目标 Agent 配置），备份存在，JSON 合法。
- [ ] 关闭设置窗口后再次双击安装包/快捷方式，只聚焦已有实例，不产生第二个托盘。
- [ ] 退出后 host 子进程结束（任务管理器无残留 `mo-agent-host.exe`）。
- [ ] 日志写入 `%LOCALAPPDATA%\mo-agent\logs`，轮转可用。
- [ ] 重启服务后面板自动恢复；runtime 版本更新不因文件占用失败。
- [ ] 卸载后用户数据仍在；文档给出清理路径。

### 9.2 Ubuntu 22.04 / 24.04 x64

- [ ] AppImage `chmod +x` 后可启动；FUSE 缺失时有替代说明。
- [ ] X11 下托盘菜单、设置面板、日志、重启、单实例可用。
- [ ] GNOME 无 AppIndicator 扩展时，应用给出可操作的提示而不是静默无托盘。
- [ ] `~/.mo-agent` 与 `$XDG_DATA_HOME/mo-agent/runtime`、`$XDG_STATE_HOME/mo-agent/log` 路径正确。
- [ ] Claude Code/Qoder CN transcript 目录可被读取（若已安装）。
- [ ] 手机扫码配对通过局域网完成。
- [ ] 全局快捷键在 Wayland 下不可用时，托盘仍可完成所有操作。

### 9.3 macOS 回归

- [ ] `./scripts/build-desktop.sh` 产物仍是 `desktop/build/stable-macos-arm64/mo-agent.app`。
- [ ] 菜单栏图标、Dock 隐藏、设置面板、语音、日志、单实例行为不变。
- [ ] 现有 `~/Library/Application Support/mo-agent/runtime` 不被迁移/删除。
- [ ] `npm test` 全绿；新增路径测试不依赖真实平台。

### 9.4 自动化

- [ ] `core/platform-paths.test.mjs`：三平台 userData/runtime/log/session 路径断言；`~`、`%LOCALAPPDATA%`、`$XDG_DATA_HOME` 展开。
- [ ] `host/agent-hooks.test.mjs` 增加 Windows 命令 golden test（含空格、中文路径）。
- [ ] `adapters/process-scan.test.mjs`：Windows CIM JSON fixture、损坏输出、超时降级。
- [ ] `adapters/transcript-adapter.test.mjs`：Windows 反斜杠根路径。
- [ ] `scripts/build-desktop.mjs` 的 dry-run/校验测试（至少检查 runtime 文件清单）。
- [ ] portability 静态检查：非 darwin 分支不得出现 `/Users/`、`Library/Application Support`、`x-apple`、`codesign`。

## 10. 风险与待验证

| 风险 | 影响 | 验证/缓解 | 优先级 |
|---|---|---|---|
| Electrobun 2.x 的 Windows/Linux 成熟度 | 托盘/窗口/安装器可能有未知坑 | 先做最小 tray-app spike；保留 Tauri 备选（《预研》结论） | 高 |
| Cottontail 在 Windows/Linux 的体积/启动 | 分发包变大、冷启动慢 | 目标机实测；必要时切 Bun 主进程 | 中 |
| Linux 托盘依赖 AppIndicator | GNOME 默认不显示托盘 | 文档 + 启动检测 + 提示安装扩展 | 高 |
| Wayland 全局快捷键/绝对定位 | 浮层/快捷键失效 | P5 前不启用语音；快捷键失败降级托盘 | 中 |
| Windows WebView2 缺失 | 面板白屏 | 安装器检测/引导安装 Evergreen Runtime；文档注明 | 高 |
| Windows hook shell 不确定 | 一键配置写入但不触发 | 每个 Agent 真机验证；未验证不写 | 高 |
| Qoder/WorkBuddy Windows userData 路径 | 标题/会话读不到 | 目标机抓目录；profile 覆盖；失败降级 | 中 |
| Windows 文件占用/杀毒锁 | runtime 升级失败、日志轮转失败 | 版本化 runtime + 重试 + 保留旧目录 | 中 |
| SmartScreen/未签名 | 用户不敢安装 | 文档说明；后续 Authenticode | 中 |
| 路径长度 260 / 中文路径 | 安装/配置写入失败 | 用长路径前缀（必要时）；测试中文用户名 | 低 |
| WSL/远程 Agent | 用户以为能看到 | 文档明确边界 | 低 |
| 语音跨平台 | 功能缺口 | 明确 macOS-only；P6 另立 | 中 |

## 11. 代码改动清单（按优先级）

### P1

- 新增 `core/platform-paths.mjs`、`core/platform-paths.test.mjs`。
- `host/index.mjs`：logFile、deviceFile、writeSessionFile、voice 配置路径。
- `host/notify-webhook.mjs`、`host/push-tokens.mjs`、`host/notify-config.mjs`、`host/voice/helper-client.mjs`、`approvals/hook-cli.mjs`。
- `host/config.mjs`：dshHome。
- `desktop/src/bun/index.ts`：RUNTIME_DIR、LOG_DIR、SINGLE_INSTANCE_*、VOICE_CONFIG、VOICE_OVERLAY_STATE、readLocalToken。
- `desktop/src/bun/single-instance.ts`：锁实现。

### P2

- 新增 `desktop/src/bun/platform.ts`。
- `desktop/src/bun/index.ts`：Carbon/ApplicationMenu/Dock/reopen/菜单/快捷键/窗口样式 gate；runtime 解包；spawn；PATH；file URL；设置入口；退出。
- `desktop/electrobun.config.ts`：win/linux icon。
- `scripts/gen-icons.mjs`：icon.png、tray-win/linux。
- `scripts/build-desktop.sh` 的平台后处理 gate（或迁移到 `build-desktop.mjs`）。

### P3

- `adapters/profiles/*.json`：platformRoots / settingsFilesByPlatform / hooks.shell（按实测结果）。
- `host/agent-hooks.mjs`：expandPath、resolveNodePath、hookCommandFor、writeSettings 重试。
- `adapters/process-scan.mjs`：Windows CIM + 降级。
- `adapters/qoder-cn-titles.mjs`：平台路径 + sqlite3 查找。
- `adapters/qoder-cn.mjs`、`adapters/dsh-monitor.mjs`、`adapters/transcript-adapter.mjs`：分隔符/basename/expandPath。

### P4

- `scripts/build-desktop.mjs`（三平台）、`scripts/build-desktop.sh` 包装、Windows/Linux 安装/卸载说明。
- `.github/workflows/desktop.yml`。
- README 的「桌面托盘（macOS）」改为「桌面托盘（macOS / Windows / Linux）」，并链接本文。

## 12. 参考

- `docs/research/desktop-shell-prestudy.md`：Electrobun vs Tauri 选型与体积实测。
- `docs/adr/adr-0001-observational-first.md`：观察优先、不接管 Agent 进程。
- `docs/adr/adr-0002-hands-free-voice.md`：语音架构与 macOS-only 的原因。
- `desktop/.hutch/dependencies.lock`：Electrobun/Hutch 的平台锁定。
- Electrobun 2.0.2 `api/config/ElectrobunConfig.ts`、`api/shared/naming.ts`、`api/shared/platform.ts`。
