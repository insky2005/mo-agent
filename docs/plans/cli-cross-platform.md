# CLI 跨平台（Windows / Linux）

状态：**进行中**（执行者协议、可执行文件查找、shell 选择、Windows 安装器已落地；Windows CI/真机验收待补）　日期：2026-10-23，更新 2026-11　关联：[桌面端跨平台方案](desktop-cross-platform.md)

## 0. 结论先行

**目前的 CLI 是 POSIX 假设，Windows 上跑不起来。** 桌面端有跨平台方案，但 `cli/` 是后加的，没有走同一套约束。

在 Windows 上可用需要动四块：执行者协议、shell 选择、路径查找、安装器。**不做交叉验证的部分不写代码**——没有 Windows 机器测过的"支持"等于埋雷。

## 1. 现状审计

| 位置 | 假设 | Windows 上的后果 |
|---|---|---|
| `cli/lib/executors.mjs` | `$(cat)` 做命令替换 | `shell: true` 在 Windows 走 cmd.exe，`$()` 不可用，全部模板失效 |
| `cli/lib/runner.mjs` | 子进程用 POSIX shell | 需要按平台选 cmd / PowerShell |
| `cli/lib/executors.mjs` `which()` | `X_OK` 位判断可执行 | Windows 没有执行位，且要按 `PATHEXT` 找 `.exe/.cmd/.bat` |
| `scripts/install-*.sh` | bash / uname / shasum | 原生 Windows 无 bash；需 PowerShell 安装器 |
| `scripts/build-cli.sh` | bash 调用 bun | 需 Git Bash/WSL，或改用 Node 脚本驱动 |
| `skills/mo/SKILL.md` | `curl | bash`、`git clone` + `bash` | 安装引导对 Windows 用户无效 |
| 产物命名 | `mo-<platform>` | Windows 需要 `.exe`，且 PATH 目录不同（`%USERPROFILE%\bin` 更常见） |

不受影响的：`core/tasks/*` 纯逻辑；`cli/lib/paths.mjs`、`store.mjs` 用的是 `os.homedir()` + `path.join`，本身跨平台。

## 2. 方案

### 2.1 执行者协议改为「stdin-only」

现在的模板依赖 `"$(cat)"` 把 prompt 塞进参数。改成只靠 stdin（runner 本来就把信封写进子进程 stdin）：

```
claude   → claude -p --permission-mode acceptEdits      （stdin 即 prompt）
codex    → codex exec -s workspace-write -              （已支持）
qodercli → qodercli -p --permission-mode accept_edits
```

**逐个 Agent 在 POSIX 上验证后再改模板**；`pi` / `qwen` 不确认就保留 `$(cat)`，并标 `posixOnly`。

模板增加平台标记：`{ posix: "...", win32: "..." }`，由 `resolveAgent` 按 `process.platform` 选。

### 2.2 shell 选择

runner 增加 `resolveShell(platform)`：POSIX 用 `/bin/sh`，Windows 用 `powershell.exe -NoProfile -Command`（或 `cmd /c`，取决于模板写法）。模板与 shell 必须配对，不能在 Windows 里塞 POSIX 语法。

### 2.3 路径查找

`which()` 改为平台感知：非 Windows 保留 `X_OK` 检查；Windows 遍历 `PATH` + `PATHEXT`。这条有明确规格，可以现在就改，但仍然需要 Windows 上跑一次测试才算数。

### 2.4 安装与分发

| 平台 | 安装器 | 产物 |
|---|---|---|
| macOS / Linux | `scripts/install-remote.sh` | `mo-darwin-arm64` / `mo-linux-x64` |
| Windows | `scripts/install-cli.ps1` | `mo-windows-x64.exe` |

构建沿用桌面端结论：**不在 macOS 上交叉编译 Windows 产品**，用 GitHub Actions 的 `windows-latest` 原生构建，产物直接上传 Release。

安装目录：`%USERPROFILE%\.local\bin` 并提示加入用户 PATH（不改系统 PATH，不写注册表）。

### 2.5 技能与文档

SKILL.md 的安装段按平台分支：Windows 给 `irm ... | iex` 或下载 `.ps1` 后执行；技能安装路径继续用 `os.homedir()`，即 `C:\Users\<user>\.agents\skills\mo`。

## 3. 验收

Windows 10/11 x64 上：

1. `mo --version` / `mo doctor` 正常；
2. `mo project init .`、`mo task create/confirm/dispatch` 全流程；
3. 用仓库自带的假执行者跑通 `done`（不依赖任何模型登录）；
4. `mo skill install` 落到 `%USERPROFILE%\.agents\skills\mo`；
5. 补全不要求（PowerShell 补全单独做，可后置）。

## 4. 不做

- **WSL 不算原生支持**：可以在 WSL 里用，但那是 Linux 路径，工程上按 Linux 验收；
- 不在 macOS 上交叉编译 Windows 二进制再"声称支持"；
- 不为 Windows 单独维护一套任务/账本语义——数据格式必须完全一致。

## 5. 实现记录（2026-11）

已落地：

- `cli/lib/platform.mjs`：PATH 平台分隔符、Windows `PATHEXT`、`findExecutable`、`resolveShell`；
- `cli/lib/executors.mjs`：按平台选命令；claude / codex / qodercli / qoderclicn 有无头 stdin 模板；pi / qwen 标 `posixOnly`，Windows 明确报 `E_UNSUPPORTED_PLATFORM`；
- `cli/lib/runner.mjs`：POSIX 用 `/bin/sh`，Windows 用 `%ComSpec%`，`MO_SHELL` 可覆盖；
- `scripts/install-cli.ps1`：装到 `%USERPROFILE%\.local\bin`，写 `install.json`，不改系统 PATH/注册表；
- `npm run check` 加入新文件，`cli/platform.test.mjs` 覆盖 PATHEXT / shell / Windows 模板选择。

仍未做（验收前不能声称 Windows 支持）：

- GitHub Actions 的 `windows-latest` / `ubuntu-latest` 矩阵与假执行者全流程；
- Windows 会话型 worker 的脚本与终端（`session-launch` 仍是 bash 脚本 + iTerm/Terminal.app）；
- `host/agent-hooks.mjs` 的 node 解析与 hook 命令生成（PowerShell 引号）；
- `install-remote.ps1`、`mo-windows-x64.exe` 的发布产物；
- 真机验证 `mo doctor` / `mo setup` / 建卡派单。
