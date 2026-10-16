# 预研：Agent 状态监听与控制，有哪些业界规范可以借鉴

日期：2026-10-16

## 0. 结论先行

有三条规范可以直接抄，而且分别管三件不同的事：

| 要解决的问题 | 抄谁 |
|---|---|
| **状态词表**（运行中/等人/完成/失败） | **A2A 的 TaskState** |
| **事件流形态**（怎么把状态推给前端） | **AG-UI 的事件类型** |
| **控制通道**（发指令/中断/审批） | **ACP**（我们已确认可用） |
| **观测底座**（长期、跨厂商） | **OpenTelemetry GenAI 语义约定** |

还有一条重要判断：**「监听用户自己启动的进程」这件事，业界目前没有统一标准。** 有标准的都假定「你是那一端、由你来管」（ACP/AG-UI/A2A 都是这样）。唯一有希望成为共识的是 **OpenTelemetry** —— 让 Agent 自己发遥测，观测端订阅。

## 1. 规范全景

| 规范 | 方向 | 管什么 | 主导方 | 对我们的价值 |
|---|---|---|---|---|
| ACP | 客户端 ↔ Agent | 启动与驱动单个 Agent | Zed | 控制通道 |
| AG-UI | Agent/后端 → 前端 | 把运行状态流式推给 UI | CopilotKit 社区 | **事件模型** |
| A2A | Agent ↔ Agent | 任务生命周期 + 推送 | Linux Foundation | **状态词表 + 推送** |
| MCP | Agent ↔ 工具 | 工具/资源/elicitation | Anthropic | 「问用户」的通用表达 |
| OTel GenAI | 遥测 | spans/metrics/events | OpenTelemetry | **长期观测底座** |

## 2. A2A 的 TaskState —— 状态词表直接抄

从 A2A v1.0 规范里提取的完整枚举（9 个）：

```
TASK_STATE_SUBMITTED       已提交，未开始
TASK_STATE_WORKING         处理中
TASK_STATE_RUNNING         处理中（与 WORKING 并存，历史遗留）
TASK_STATE_INPUT_REQUIRED  ⭐ 等用户输入
TASK_STATE_AUTH_REQUIRED   ⭐ 等用户授权
TASK_STATE_COMPLETED       正常完成
TASK_STATE_CANCELED        被中断
TASK_STATE_FAILED          失败
TASK_STATE_REJECTED        被拒绝
```

另外两个配套概念也值得抄：
- `contextId`（把一串交互归为一个上下文）+ `taskId`（单次任务）。对应我们的「会话」与「一轮任务」。
- **中断态 vs 终止态**的划分：中断态 = input-required / auth-required（可恢复）；终止态 = completed / canceled / rejected / failed。

### 对我们状态模型的直接修正

我们现在用的是「运行中 / 等待回应 / 空闲 / 出错」，有本质问题：**`空闲` 不是任务状态，而是「没有活跃任务」**。正确做法是把「进程/会话是否存在」和「任务处于什么状态」分开建模：

| 我们的场景 | 应映射为 |
|---|---|
| 刚收到指令、还没开跑 | SUBMITTED |
| Agent 正在干活 | WORKING |
| Agent 调用了 ask_user_question | INPUT_REQUIRED |
| Agent 请求工具授权 | AUTH_REQUIRED |
| 一轮跑完 | COMPLETED |
| 用户点了中断 | CANCELED |
| 报错退出 | FAILED |
| 会话在、但无活跃任务 | 无活跃 Task（不是一种状态） |

## 3. AG-UI 的事件类型 —— 事件流直接抄

AG-UI 是「Agent 把运行状态流式推给前端」的协议，事件分类如下：

| 类别 | 事件 |
|---|---|
| 生命周期 | `RunStarted`、`StepStarted`、`StepFinished`、`RunFinished`、`RunError` |
| 文本消息 | `TextMessageStart`、`TextMessageContent`、`TextMessageEnd`、`TextMessageChunk` |
| 工具调用 | `ToolCallStart`、`ToolCallArgs`、`ToolCallEnd` |
| 状态同步 | State 管理类事件 |
| 活动 | Activity 类事件 |
| **子 Agent** | Subagent 事件（用 `subagentRunId` 归因输出） |
| 特殊/草案 | Special、Draft 类 |

基础字段：`type`、`timestamp`、`rawEvent`、`metadata`（开放的 key-value，塞 token 用量、traceId、finish reason）、以及可选的 `subagentRunId`。

### 最关键的一条：run 的结局是「成功」还是「被中断」

`RunFinished` 带一个 outcome 判别联合：
- `outcome: { type: success }` —— 正常跑完
- `outcome: { type: interrupt, interrupts: [...] }` —— **暂停等人**，客户端用 `resume` 数组恢复

这正好就是我们要的「Agent 在问我/等我授权」。**比我们自己设计一套 好，因为语义边界已经被论证过**（比如 interrupt 的续跑契约、错误分类）。

## 4. ACP —— 控制通道（已确认可用）

从本机 SDK schema 提取的关键方法：

| 能力 | 方法 |
|---|---|
| 会话生命周期 | `session/new`、`session/load`、`session/list`、`session/resume`、`session/fork`、`session/close`、`session/delete` |
| 驱动 | `session/prompt`、`session/cancel` |
| 配置 | `session/set_model`、`session/set_mode`、`session/set_config_option` |
| 流式状态 | `session/update` |
| **审批** | `session/request_permission` |
| 客户端反向能力 | `fs/read_text_file`、`fs/write_text_file`、`terminal/*` |

限制：ACP 是「客户端启动 Agent」模型，挂不上用户自己已经跑起来的进程。

## 5. MCP 的 elicitation —— 「问用户」的通用措辞

MCP 除了工具，还定义了 elicitation（Agent 在运行中向用户索取信息）与 sampling。它的价值不在直接实现，而在于**和 A2A 的 INPUT_REQUIRED、AG-UI 的 interrupt 是同一个概念的三种表达**。我们统一事件模型时，这三者应该收敛成一个。

## 6. OpenTelemetry GenAI 语义约定 —— 观测底座

GenAI 语义约定已从主仓库迁到独立仓库（semantic-conventions-genai），内容仍在快速演进，包含：
- **Agent spans**：create agent、invoke agent（client / internal）、invoke workflow、**plan**、**execute tool**、load skill、read skill resource、command execution 等。
- GenAI spans / metrics / events / exceptions。
- **MCP 专用约定**（对 MCP 调用做标准化观测）。
- 厂商专用：Anthropic、OpenAI、AWS Bedrock、Azure AI 等。

对我们的意义有两层：
1. **我们能把自己推导出的状态也输出成 OTel**（`gen_ai.agent.name` 等），这样用户已有的观测栈（Grafana、Datadog、Phoenix、Langfuse）能直接消费我们的观察结果。
2. 更重要：**如果目标 Agent 自己发 OTel，我们就直接订阅，不用解析日志**。这比 tail JSONL 稳得多，也是「监听所有 Agent」最有希望的标准路径。

## 7. 建议的落地方式：三层对齐

```
L1/L2  进程 + 日志 tail      → 务实层（没有标准，我们自己定义 Profile）
L3     厂商 hooks            → 厂商事实标准（Claude Code / Codex 的 hook 协议）
L4     OpenTelemetry         → 行业标准层（有就订阅，没有才猜测）

统一事件模型 = AG-UI 事件形态 + A2A 状态词表
对外遥测     = OpenTelemetry GenAI 语义约定
控制通道     = ACP（能托管时）
```

### 内部统一事件模型草案

| 内部事件 | 对应 AG-UI | 对应 A2A 状态 |
|---|---|---|
| agent.run.started | RunStarted | SUBMITTED → WORKING |
| agent.step.started / finished | StepStarted / StepFinished | WORKING |
| agent.text.delta / end | TextMessageContent / End | WORKING |
| agent.tool.started / args / finished | ToolCallStart / Args / End | WORKING |
| agent.subagent.* | Subagent 事件 + subagentRunId | WORKING |
| agent.needs.input | RunFinished(outcome=interrupt) | INPUT_REQUIRED |
| agent.needs.auth | RunFinished(outcome=interrupt) | AUTH_REQUIRED |
| agent.run.completed | RunFinished(success) | COMPLETED |
| agent.run.failed | RunError | FAILED |
| agent.run.canceled | —— | CANCELED |

我们已有的 `seq` 自增序号可以作为 SSE 的 id 保留；AG-UI 的 `metadata` 用来挂 token 用量与 traceId。

## 8. 推送通道

A2A 定义了 pushNotificationConfig：客户端注册一个 webhook，长任务状态变化时由 Agent 反向推送。我们的内网 SSE + seq 断点续推已经够用，但如果以后要出内网，可以按这个模型加一条「注册回调」的通路。事件信封可对齐 **CloudEvents**（id / source / type / time / subject / data）。

## 9. 参考链接

- ACP：https://agentclientprotocol.com
- ACP Registry：https://github.com/agentclientprotocol/registry
- AG-UI 事件：https://docs.ag-ui.com/concepts/events
- AG-UI 中断：https://docs.ag-ui.com/concepts/interrupts
- A2A 规范：https://a2a-protocol.org/latest/
- A2A Life of a Task：https://a2a-protocol.org/latest/topics/life-of-a-task/
- MCP：https://modelcontextprotocol.io
- OTel GenAI 语义约定：https://github.com/open-telemetry/semantic-conventions-genai
