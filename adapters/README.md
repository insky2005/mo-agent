# 接入一个新的 Agent

目标：新增 Agent 只需要 **profile + adapter + fixtures**，不改 `core/`、`host/notify*`、`app/web/`。
规范的唯一事实源是 [core/contract.mjs](../core/contract.mjs) 和 [事件契约设计](../docs/spec/event-contract.md)。

## 1. 复制 profile

```bash
cp adapters/profiles/_template.json adapters/profiles/<id>.json
```

填写：

| 字段 | 说明 |
|---|---|
| `id` / `label` | 唯一标识与显示名 |
| `module` | adapter 模块，相对 `adapters/`，例如 `"./foo.mjs"` |
| `export` | 模块里导出的类名；缺省用 `default` |
| `session` | 数据源位置/格式，adapter 自己解释 |
| `capabilities.observe` | `process` / `transcript` / `native-api` / `acp` / `extension` / `log` |
| `capabilities.runEnd` | `explicit` / `inferred` / `none` |
| `capabilities.attention` | `hook` / `native` / `derived` / `extension` / `none` |
| `capabilities.approval` | `allow` / `deny` / `none` |
| `hooks.events` | 厂商 hook 名 → 规范事件，例如 `"Notification": "notice"` |

`runEnd: none` 表示只能看进程在不在：只发 `session.upsert`，**不要发 `run.*`**，UI 显示 `working` / `idle`，不伪造“已完成”。

## 2. 写 adapter

在 `adapters/<id>.mjs` 导出一个类：

```js
export class FooAdapter {
  constructor({ hub, log, profile, config, dsh }) { ... }
  start() { ... }
  stop() { ... }
}
```

硬规则：

- 只发 [EVENT_META](../core/contract.mjs) 里的规范事件；
- 不发 `notify`，不写手机端文案，不直接调 HMS；
- 一轮结束先发 `session.upsert`（带 `status` 与 `runId`），再发 `run.completed`；
- `runId` 用 `makeRunId(sessionId, turnKey)`，同一轮开始/结束必须一致；
- 首轮扫描只建立基线，不补发历史完成通知；
- `capabilities.runEnd === "none"` 时不发 `run.*`；
- `capabilities.control` 里没有 `prompt` / `cancel` 时，手机端会隐藏发送/中断按钮，后端返回 409，不要假设所有会话都能控制。

可参考：

- [adapters/dsh-monitor.mjs](dsh-monitor.mjs)：`runEnd: inferred`，轮次推进 + 实时 status；
- [adapters/claude-code.mjs](claude-code.mjs)：`runEnd: explicit`，transcript `end_turn`；
- [adapters/qoder-cn.mjs](qoder-cn.mjs)：同一个 transcript 基类，换目录与命名；
- [adapters/pi.mjs](pi.mjs)：不同构的 JSONL（`type: "message"` + 树形分支），单独解析。

如果新 Agent 的 transcript 也是 Claude Code 同构（`user` / `assistant` / `stop_reason`），
不要复制一份解析逻辑，直接继承 [adapters/transcript-adapter.mjs](transcript-adapter.mjs)，
只声明 `name`、`rootEnv`、`defaultRoot`、`defaultLabel` 即可。

## 3. 加 fixtures 和测试

在 `adapters/<id>.test.mjs` 里用脱敏后的真实日志/transcript 覆盖：

- 首次扫描、运行中、完成、失败、等待输入、会话消失、重启恢复；
- 只发白名单事件、必填字段、状态机、顺序、`runId` 去重；
- `runEnd: none` 不发完成事件。

契约测试会自动发现 `adapters/profiles/*.json`：

```bash
npm test
```

## 4. 注册与打包

不需要改 `adapters/registry.mjs`：它按 `profile.module` 动态 import。
桌面构建会把 `adapters/*.mjs`、`core/*.mjs` 与 `integrations/pi` 一起复制进运行时，所以动态加载/扩展安装都能在打包后工作。

## 5. hooks（可选）

在 profile 里声明 `hooks.events`，然后让 hook 调用：

```bash
node approvals/hook-cli.mjs event <HookEvent> <agent-id>
```

hook-cli 会读 profile 的映射：

- `approval.pending` → `/local/approval`（阻塞等手机决定，超时交回终端）
- `notice` → `/local/notify`（只提醒）

其它目标（如 `run.completed`）暂不走 hook 路径，避免与 adapter 的完成信号重复。

## 6. 进程内控制扩展（Pi）

Pi 没有外部 hook 配置，也没有原生工具审批；要控制用户自己开的 Pi，只能装一个进程内扩展：

- 扩展源码：`integrations/pi/`
- 安装/卸载：`host/pi-extension.mjs`、`scripts/install-pi-extension.mjs`
- 协议：host 的 `/local/pi/*` 长轮询（见 `host/http.mjs`、`adapters/pi-control.mjs`）

它只做 `sendUserMessage` / `ctx.abort` / 事件上报，不注册 `tool_call`，所以不会拦工具，也不会因为 Mo 不在而阻断 Pi。
