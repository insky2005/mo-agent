# ADR-0003：统一事件契约与映射层

状态：**已采纳（M1–M4 已落地）**　日期：2026-10-18　关联：[事件契约设计](../spec/event-contract.md)

## 背景

Claude Code 接入后暴露了三个问题：状态不实时、展示的“你”停留在第一问、完成时不发 HMS 通知。排查后发现问题不在某一个适配器，而在三层契约同时缺失：

- 事件名有两套：`core/events.mjs` 的 `agent.*` 与实际的 `session.upsert` 字面量；
- 状态语义不一致：DSH 一轮结束是 `idle`，Claude 是 `completed`；
- 映射责任错位：DSH 适配器直接决定“完成通知”，Claude 适配器发 `run.completed` 却没人翻译；profile 里的 hooks 映射没有代码读取。

## 决策

采用**一套规范领域事件 + 四张显式映射表 + 契约测试**：

1. 规范事件只有 `session.*`、`run.*`、`pending.*`、`approval.*`、`notice`、`source.error`；`notify` 是派生输出，适配器禁止发。
2. 适配器只陈述事实，不决定通知文案；状态、通知、UI 各自查表。
3. 状态语义固定：Terminal（`completed/failed/canceled/rejected`）表示最近一轮结果；`idle` 只表示“没有正在跑的轮次，也没有可判定的最近结果”。**禁止把“没在跑”写成 `idle` 来替代 `completed`。**
4. 一轮结束先发 `session.upsert`（带终态与 `runId`），再发 `run.*`；通知按 `runId` 去重。
5. 新增 Agent 只需 profile + adapter + fixtures，不改 core / notify / 手机端；能力（`runEnd: explicit|inferred|none`）显式声明，弱能力不伪造完成。
6. SSE 改为单一 `message` 信封，客户端按 `type` 分发，删除手写订阅清单（M2）。

完整设计、事件表、状态规则、映射表、接入清单与迁移计划见 [docs/spec/event-contract.md](../spec/event-contract.md)。

## M1 落地记录

- 新增 `core/contract.mjs`，`core/events.mjs` 改为 re-export。
- Notifier 改为查 `NOTIFY_POLICY` 表；补上 `run.completed` / `run.failed` / `run.canceled`。
- DSH 一轮结束现在置 `completed` 并发 `run.completed`，不再发 `notice(completed)`；`completed` 保持粘性。
- Claude 适配器的完成事件补上 `runId`。
- Hub 在入口归一化旧事件名；SSE 重放跳过 `run.*` / `notice` / `notify`。
- 新增 `core/contract.test.mjs`、`adapters/contract.test.mjs`，并扩充 DSH/Claude 适配器测试；`npm test` 195 项全绿。

## M2 落地记录

- 服务端 `/api/events` 支持 `?envelope=1`，发 `event: message` 统一信封；事件补 `v: 1`。
- 不带 `envelope` 的旧 named event 保留一个迁移窗口，旧手机页面不会立刻失效。
- `app/web/app.js` 与 `approvals.js` 改为 `onmessage` 按 `type` 分发，删除手写事件清单。
- 新增 `host/http.test.mjs` 覆盖新旧帧格式；`npm test` 195 项全绿。

## M3 落地记录

- registry 改为按 `profile.module` + `profile.export` 动态 import；新增 Agent 不改 registry。
- `runEnd: none` 的能力门控落到 DSH / Claude 适配器：只更新状态，不发 `run.*`。
- `approvals/hook-map.mjs` 读取 `profile.hooks.events`；`hook-cli.mjs event <HookEvent> <agent>`，旧命令兼容。
- 新增 `adapters/profiles/_template.json` 与 `adapters/README.md`。
- 打包脚本把 `adapters/*.mjs` 与 `core/*.mjs` 复制进运行时；Bun 单文件包的动态 import 已实测。
- `npm test` 211 项全绿（含来源标识与控制能力门控）。

## M4 落地记录

- 删除 `agent.*` / `agent.needs.*` / `session.started` / `dsh.error` 别名。
- `notice` 只保留 attention 语义；完成/失败统一 `run.*`，删除重复通知分支。
- SSE 只发 `event: message`，删除 named event 与 `?envelope=1` 协商。
- `scripts/gen-capabilities.mjs` 生成 [docs/capabilities.md](../capabilities.md)，`npm run check` 校验时效。
- `npm test` 211 项全绿。

## 结果

- 手机端不再依赖“适配器恰好发了某个事件名”；漏订阅这类 bug 在类型/契约层被拦住。
- DSH 与 Claude 的“已完成/空闲”语义一致；L1 进程型 Agent 可以只到 `idle`，不伪造完成。
- 通知策略只有一处，新增 Agent 不会重复实现“任务完成”。
- 代价：M1 需要改 DSH/Claude 适配器、Hub、Notifier 并补契约测试；M2 需要手机端配合升级 SSE 分发；M4 后旧客户端必须刷新/升级。

## 被否决的替代方案

- **只补一个 `RUN_COMPLETED` 分支**：能修当前 bug，但下一个 Agent 仍会踩事件名/状态语义的坑。
- **把所有厂商事件塞进一个巨型枚举**：厂商协议不稳定，会让核心词汇跟着变。
- **让每个适配器自己发通知**：通知分级、去重、文案会继续分裂，手机端无法统一。
