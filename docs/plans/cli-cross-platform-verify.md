# 跨平台 CLI 验证备忘

- 分支：`feat/cli-cross-platform`
- 基线：`4fc4d56 feat(cli): 跨平台基础：PATHEXT、shell 选择、Windows 安装器`
- 日期：2026-11
- 目标：在不依赖 macOS 桌面端的前提下，验证 Linux / Windows 上 CLI + daemon 是否可用

## 0. 结论

- **Linux（Ubuntu）可以用 Docker 验证**：CLI、配置、setup、MCP stdio、daemon 的 HTTP 接口都能在 `node:22-bookworm` 里跑；终端开窗、语音、手机推送、钉钉这类依赖图形/外设/凭据的能力无法验证。
- **Windows 不能用 Docker 验证**（macOS 上的 Docker Desktop 只能跑 Linux 容器）：需要 Windows 虚拟机，或 GitHub Actions 的 `windows-latest`。
- 验证通过前，文档里只能写「Windows 正在补齐」，不能写「已支持」。

## 1. 当前进度（对照 [cli-cross-platform.md](cli-cross-platform.md)）

已落地：

| 内容 | 位置 |
|---|---|
| PATH 分隔符 / `PATHEXT` / 可执行文件查找 / shell 选择 | `cli/lib/platform.mjs` |
| 执行者按平台选命令；Windows 无头模板走 stdin；pi/qwen 标 `posixOnly` | `cli/lib/executors.mjs` |
| runner 按平台选 shell（`/bin/sh` / `%ComSpec%` / `MO_SHELL`） | `cli/lib/runner.mjs` |
| worker 标记 `supported`，不支持平台明确报错 | `cli/lib/workers-config.mjs` |
| Windows 安装器（用户目录，不改系统 PATH/注册表） | `scripts/install-cli.ps1` |
| 单测：PATHEXT、PATH、shell、Windows 模板 | `cli/platform.test.mjs` |

仍未落地：

- 会话型 worker 的 Windows 启动脚本与终端探测（`session-launch.mjs` 仍是 bash + iTerm/Terminal.app）；
- `host/agent-hooks.mjs` 的 node 解析与 PowerShell 引号；
- Windows CI、`mo-windows-x64.exe` 产物、`install-remote.ps1`；
- Linux/Windows 真机跑通 `mo doctor` / `mo setup` / 建卡派单。

## 2. Linux：Docker + Ubuntu

### 2.1 一键跑

新增脚本 `scripts/verify-linux-docker.sh`：

```bash
bash scripts/verify-linux-docker.sh
```

它会：

1. 把仓库（排除 `.git`、`node_modules`、`cli/dist`）用 tar 流送进 `node:22-bookworm`；
2. 容器内 `npm ci && npm test && npm run check`；
3. 用临时 `MO_AGENT_HOME` 跑 `doctor`、`config set/get`、`memory init`。

可换镜像（例如你们自己的镜像仓库）：

```bash
MO_VERIFY_IMAGE=<registry>/library/node:24-bookworm bash scripts/verify-linux-docker.sh
MO_VERIFY_IMAGE=<registry>/library/node:22-slim bash scripts/verify-linux-docker.sh
```

`slim` 镜像没有 git / 编译工具，部分测试可能需要 `node:24-bookworm` 这类完整镜像。

`package-lock.json` 统一走公共源（`registry.npmjs.org`），容器里可以直接 `npm ci`；要换源用 `MO_VERIFY_NPM_REGISTRY`，脚本只在容器内加 `--registry`，不改仓库文件。

### 2.2 手工等价命令

```bash
tar --exclude=.git --exclude=node_modules --exclude=cli/dist --exclude=.mo-agent -cf - . \
  | docker run -i --rm -w /work -e HOME=/tmp/mo-home node:22-bookworm bash -lc '
      set -euo pipefail
      mkdir -p /work "$HOME"
      tar -xf - -C /work
      cd /work
      npm ci --no-audit --no-fund
      npm test
      npm run check
      export MO_AGENT_HOME="$(mktemp -d)"
      node cli/mo.mjs doctor
      node cli/mo.mjs config set port 7799
      node cli/mo.mjs config get port
      node cli/mo.mjs memory init --json
    '
```

### 2.3 手工验收清单（容器内）

```bash
# 1) 自检
node cli/mo.mjs doctor

# 2) 首次装配：跳过终端和 MCP（容器里没有图形终端/客户端配置）
mkdir -p /tmp/fakebin
printf '#!/bin/sh\nexit 0\n' > /tmp/fakebin/claude
chmod +x /tmp/fakebin/claude
export PATH="/tmp/fakebin:$PATH"
export MO_AGENT_HOME="$(mktemp -d)"
node cli/mo.mjs setup --only dirs,config,memory,worker,skill --yes --json
node cli/mo.mjs setup --only dirs,config,memory,worker,skill --yes --json   # 第二次应全是 skipped

# 3) 配置
node cli/mo.mjs config set port 7799
node cli/mo.mjs config get port

# 4) 记忆
node cli/mo.mjs memory init
node cli/mo.mjs memory list

# 5) MCP stdio 握⼿
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node cli/mo.mjs mcp
```

建卡/派单全流程已经被 `npm test` 覆盖（测试里用假执行者），需要手工再验时用 `cli/default-worker.test.mjs` 里那套：写一个 `node exec.mjs`，从 stdin 读信封、写 `MO_RECEIPT`，然后 `task create → confirm → approve --yes → dispatch`。

### 2.4 daemon 验证与浏览器限制

容器内：

```bash
node host/index.mjs --host 127.0.0.1 --port 7788 &
curl -s http://127.0.0.1:7788/api/health
cat ~/.mo-agent/session.json   # 拿本机 token
curl -s "http://127.0.0.1:7788/monitor?token=<token>" | head
```

注意：`/monitor`、`/settings`、`/logs` 只允许**回环地址**。从宿主机浏览器通过端口映射访问时，daemon 看到的来源不是 127.0.0.1，会 403。Linux 宿主可以用 `--network host`；macOS Docker Desktop 建议在容器内用 `curl` 验证，或只验证 `/api/health`。

### 2.5 Docker 验证不了什么

- 会话型 worker 的终端开窗（iTerm / Terminal.app / Windows Terminal）；
- 语音、手机推送、钉钉、配对二维码的人工流程；
- systemd / launchd 开机自启；
- Windows 特有行为。

## 3. Windows 验证

Docker（macOS 宿主）只能跑 Linux 容器，**不能验证 Windows**。两条路：

1. **GitHub Actions `windows-latest`**（推荐）：原生 Windows，可重复；
2. 本地 Windows 10/11 x64 虚拟机（Parallels / VMware / Hyper-V）。

### 3.1 Windows 验收步骤（PowerShell）

```powershell
# 前提：Node 18+、bun（用于构建单文件）
git clone <repo>; cd mo-agent
npm ci
npm test
npm run check

# 构建 Windows 产物（必须在 Windows 上构建，不交叉编译）
bun build --compile --minify cli/mo.mjs --outfile cli\dist\mo.exe

# 安装到用户目录
powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
mo --version
mo doctor

# 首次装配（终端探测在 Windows 应落到 print 或自定义终端）
$env:MO_AGENT_HOME = "$env:TEMP\mo-home"
mo setup --yes --json

# MCP 握手
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | mo mcp
```

### 3.2 Windows 已知阻塞

- `session-launch.mjs` 生成 bash 脚本，Windows 会话型 worker 还跑不起来；
- `host/agent-hooks.mjs` 的 node 解析与 hook 命令仍是 POSIX 引号；
- `pi` / `qwen` 无头模板标记 `posixOnly`，Windows 会明确报 `E_UNSUPPORTED_PLATFORM`；
- 测试套件里仍有 POSIX 假设（spawn shell、路径、chmod），全量 `npm test` 在 Windows 上预计有失败，需要先做 CI 基线。

## 4. 验收判据

| 项 | Linux（Docker） | Windows（VM/CI） |
|---|---|---|
| `npm test` / `npm run check` | 必须全绿 | 先记录基线，允许先排除 POSIX-only 用例 |
| `mo doctor` | 通过 | 通过 |
| `mo config set/get` | 通过 | 通过 |
| `mo setup --yes` | 关键步骤通过（终端会 warn） | 关键步骤通过 |
| 假执行者建卡→派单→done | 通过 | 通过 |
| `mo mcp` initialize/tools/list | 通过 | 通过 |
| daemon `/api/health` | 通过 | 通过 |
| `/monitor` 本机 token | 容器内 curl 通过 | 本机浏览器通过 |
| 会话型 worker 开窗 | 不验 | 待 session-launch 改造后验 |

## 5. 结果记录（每次验证填一行）

| 日期 | 平台 | 镜像/版本 | commit | 结果 | 失败项 / 备注 |
|---|---|---|---|---|---|
| 2026-11 | Linux (Docker) | `node:24-bookworm`（Node 24.18.0） | 跨平台基础提交 + 验证修复 | ✅ `npm test` / `npm run check` / `doctor` / `config set-get` / `memory init` 全通过 | root 容器下跳过 1 个 chmod 权限用例；终端开窗、语音、手机推送不在范围 |