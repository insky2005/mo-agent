# Pi 控制扩展

Pi 默认不弹工具授权框，也没有外部控制 socket。Mo Agent 对「用户自己开的 Pi」只做两件事：

- **观测**：读 `~/.pi/agent/sessions/**/*.jsonl`，不需要装任何东西。
- **控制**：装一个只负责收发指令的 Pi 扩展，发指令 / 中断。

不包含审批：不会拦工具，也不会因为 Mo 不在而阻断 Pi。

## 安装

### 桌面 App

设置 → **Agent 配置** → **Pi 控制扩展** → **安装控制扩展**。

host 会从运行时目录（`MO_AGENT_ROOT/integrations/pi`）读取扩展源文件，写入 `~/.pi/agent/extensions/`。桌面 App 用户不需要源码、不需要 npm。安装后重启 Pi 生效。

### 源码 / CLI

```bash
npm run pi:install
npm run pi:status
npm run pi:uninstall
```

等价于：

```bash
node scripts/install-pi-extension.mjs --install --check
```

安装位置：

```text
~/.pi/agent/extensions/mo-agent-control.js
~/.pi/agent/extensions/mo-agent-control-impl.js
```

设置了 `PI_CODING_AGENT_DIR` 时写到该目录下的 `extensions/`。

`--check` 会真实启动一次 `pi --mode rpc --no-session -e <loader>` 并请求 `get_state`，确认扩展能加载。不要用 `pi --help` 做健康检查：扩展加载失败时 `--help` 仍可能返回 0。

## 运行时行为

扩展在 Pi 进程内运行，只注册这些事件：

| 事件 | 行为 |
|---|---|
| `session_start` | 连 Mo host，注册 `sessionId` / `sessionFile` / `cwd` / `pid` |
| `before_agent_start` | 刷新 ctx；如果之前没连上，重试 |
| `agent_settled` | 上报本轮真正结束 |
| `session_shutdown` | 上报断开，停止轮询 |

指令通过 HTTP 长轮询下发：

```text
POST /local/pi/session
GET  /local/pi/commands?sessionId=...&wait=25000
POST /local/pi/ack
POST /local/pi/event
```

- 空闲时收到 `prompt` → `pi.sendUserMessage(text)`
- 运行中收到 `prompt` → `deliverAs: "followUp"`（或 `steer`）
- 收到 `abort` → `ctx.abort()`

所有请求带 `x-mo-agent-local` token，只连 localhost。

## 边界

- Mo 不在时：扩展读不到 `~/.mo-agent/session.json`，不注册、不轮询；Pi 照常使用。
- 扩展 API 没有 `clear_queue`：host 会丢掉尚未下发的 prompt；已经进入 Pi 队列的 steering/followUp 仍可能继续。
- 没有暂停/恢复。
- 只控制 `ctx.mode === "tui"` 的会话；headless / JSON / RPC 模式直接 no-op。
- 没装扩展的 Pi 仍然能被观测，只是不能发指令/中断。

## 逃生口

- `MO_PI_DISABLE=1 pi`：临时禁用控制扩展（扩展仍会被加载，但工厂直接返回）。
- `pi -ne`：完全不加载扩展。
- 桌面：设置 → Agent 配置 → Pi 控制扩展 → 卸载。
- 源码 / CLI：`npm run pi:uninstall`。
- 如果扩展加载失败导致 `pi` 起不来，用 `pi -ne` 启动后卸载。

## 文件

- 扩展源文件：`integrations/pi/`
- 安装/卸载逻辑：`host/pi-extension.mjs`
- CLI：`scripts/install-pi-extension.mjs`
- 研究记录：`docs/research/pi.md`
