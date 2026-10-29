# 个人工作台：任务流转与分支（v0 设计）

状态：**P0 / P2 / P3 已落地（CLI）**　日期：2026-10-23　关联：`docs/spec/event-contract.md`、ADR-0001（观察优先）、ADR-0003（事件契约）

## 1. 目标与非目标

### 目标

- 把「聊想法 → 落地 → 派单 → 执行 → 回执 → 归账 → 复盘」固化成一条可实现的流程；
- **每个决策点的分支显式列出**，带编号与错误码，实现时逐条对照；
- 主 Agent 可替换、项目可移动、执行者可扩展，三者都不影响流程本身。

### 非目标

- 不实现 Agent 运行时（模型、工具循环、上下文管理交给各 Agent）；
- 不做跨机器同步、账号体系、云端存储；
- 不定义 UI 视觉与交互细节（只定义 UI 可以调用什么）。

## 2. 角色

| 角色 | 是谁 | 职责 | 不该做 |
|---|---|---|---|
| **人** | 你 | 确认建卡、确认派单、审批风险动作、裁决记忆冲突 | 手动维护账本 |
| **主 Agent** | 任意可加载 manager kit 的 Agent | 澄清、拆解、建卡、派单、汇报、复盘 | 执行、自我确认、写账本、直接写记忆 |
| **core** | `mo-agent` daemon（无头） | 项目解析、状态机、派单、回执校验、账本、检索注入 | 替人做决定 |
| **执行 Agent** | Claude Code / DSH / Qoder / 人 | 按卡交付、写回执 | 改卡、改账本、二次派单 |
| **运行时** | 各 Agent 自己的进程 | 跑模型和工具 | — |

原则：**人和主 Agent 之间只传"决定"，主 Agent 和 core 之间只传"结构化调用"，core 和执行 Agent 之间只传"卡 + 回执"。**

## 3. 数据与目录

```
~/.mo-agent/                       # 跟人走，不提交
├── devices.json  notify.json  push-tokens.json
├── session.json  desktop.lock  voice.json      # 机器状态
├── config.json                                 # 解析链的配置文件
├── memory/                                     # 可被 MO_AGENT_MEMORY 覆盖
│   ├── preferences.md
│   ├── pitfalls/*.md
│   ├── decisions/*.md
│   └── candidates/*.json                      # 待裁决的候选，不进召回
├── ledger/2026-10.jsonl                        # 全局账本
├── inbox/pending/*.json  inbox/pulled/         # 待主 Agent 拉取的通知（B9.3）
├── approvals/a_*.json                          # 确认请求与裁决（B4.6）
├── projects.json                               # 项目登记表（指针）
└── scratch/tasks/                              # 无项目兜底（慎用）

<repo>/.mo-agent/                  # 跟项目走，可提交
├── README.md
├── project.json                  # 提交：{ id, name }
├── tasks/t_<ULID>.md
└── receipts/t_<ULID>.json        # 默认 gitignore

~/Library/Application Support/mo-agent/runtime/  # 程序产物，只读
```

## 4. 总流程

```
    人                主 Agent                core                 执行 Agent
    │                    │                     │                       │
    │ ① 聊想法/方案       │                     │                       │
    │───────────────────>│                     │                       │
    │                    │                     │                       │
    │ ② "开始做吧"        │                     │                       │
    │───────────────────>│                     │                       │
    │                    │ ③ task_create       │                       │
    │                    │────────────────────>│ 解析项目 → 建卡        │
    │                    │  draft + 回显       │                       │
    │                    │<────────────────────│                       │
    │ ④ 确认 / 修改 / 取消 │                     │                       │
    │───────────────────>│ ⑤ task_confirm      │                       │
    │                    │────────────────────>│ draft→confirmed       │
    │                    │ ⑥ task_dispatch     │                       │
    │                    │────────────────────>│ 选执行者 → 起进程/注入 │
    │                    │  {taskId} 立即返回   │──────────────────────>│
    │                    │<────────────────────│                       │ ⑦ 执行
    │                    │                     │                       │ ⑧ 写回执
    │                    │                     │<──────────────────────│
    │                    │                     │ ⑨ 校验 verify          │
    │                    │ ⑩ 注入/待拉取       │ ⑪ 追加账本             │
    │                    │<────────────────────│                       │
    │ ⑫ 汇报（引用 taskId）│                     │                       │
    │<───────────────────│                     │                       │
    │ ⑬ 复盘：坑与纠正     │                     │                       │
    │───────────────────>│ ⑭ memory_propose    │                       │
```

## 5. 状态机

```
draft ──confirm──> confirmed ──dispatch──> dispatched ──start──> running
  │                    │                       │                  │
  │ cancel             │ cancel                │ fail              ├─> done
  │                    │                       │                   ├─> failed
  ▼                    ▼                       ▼                   ├─> blocked ──resume──> running
canceled            canceled                failed                  └─> canceled
  │
  └─ 24h 未确认 → expired
```

- `confirm` **不改变状态**：它只发起授权请求（B4.6），`draft → confirmed` 只由 `approve` 触发；
- **终态**：`done` / `failed` / `canceled` / `expired`；
- `blocked` **不是终态**：等外部输入（人决策、重试、补权限），可回到 `running` 或走向终态；
- `verified` 是**独立字段**（`unverified` / `verified` / `verify_failed`），不是状态，避免与状态语义互相污染。

## 6. 分支总表

> 本表是**设计全集**，不等于当前实现。哪些行已经有代码、哪些还只是设计，见 §12.7 的对照表。

### 6.1 会话绑定（B1）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B1.1 | cwd 向上找到 `project.json` | 绑定该项目，静默 | — |
| B1.2 | cwd 是 git 仓库根且无 `project.json` | 标记"待认领"，首次建卡时自动写 `project.json` | — |
| B1.3 | cwd 既非项目也非 git 根 | 不绑定，标记 `unbound` | — |
| B1.4 | 会话中途 `cd` 到别处 | **不重新绑定**，归属不变 | — |
| B1.5 | 同一会话显式说"在 X 项目" | 覆盖绑定，记一条 bind 事件 | — |

> 认领只发生在**建卡**（B3）。`mo task list/status`、`mo receipt *`、`mo project agent` 这类只读或文档命令不创建 `project.json`，也不写项目注册表。

### 6.2 项目解析（B2，建卡时触发）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B2.1 | 会话已绑定 | 直接用 | — |
| B2.2 | 未绑定，参数给了 `project` 名称且唯一命中 | 用命中项 | — |
| B2.3 | 未绑定，名称命中多个 | 返回候选，等选择 | `E_PROJECT_AMBIGUOUS` |
| B2.4 | 未绑定，名称不存在 | 返回"不存在 + 相近候选 + 是否新建" | `E_PROJECT_NOT_FOUND` |
| B2.5 | 未绑定，参数给了新路径 | 要求确认，确认后建目录 + `project.json` + 登记 | `E_CONFIRM_REQUIRED` |
| B2.6 | 未绑定，无参数 | 返回候选（含 cwd 若合法） | `E_PROJECT_UNBOUND` |
| B2.7 | 登记路径不存在 | 标 `missing`，不猜、不回写历史 | `E_PROJECT_MISSING` |

### 6.3 建卡（B3）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B3.1 | 必填字段齐全（交付物、验收、边界） | 生成 `draft` 卡 | — |
| B3.2 | 缺验收标准 | 允许建卡但标 `verify: needs_human`，回显时高亮 | `W_NO_VERIFY` |
| B3.3 | 同项目已有非终态任务 | 建卡成功，回显提示"另有 N 个进行中" | `W_TASKS_IN_FLIGHT` |
| B3.4 | 卡内容超长（> 8KB） | 拒绝，要求拆分 | `E_CARD_TOO_LARGE` |
| B3.5 | 同名/近义卡已存在且非终态 | 提示"疑似重复"，不阻止 | `W_POSSIBLE_DUP` |

### 6.4 确认（B4）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B4.1 | 人批准 | `draft → confirmed`，记 `requestId`、通道与卡片指纹 | — |
| B4.2 | 人修改 | 回到 `draft`，需重新确认 | — |
| B4.3 | 人取消 | `canceled`（终态） | — |
| B4.4 | 24h 未确认 | `expired`（终态），不自动派发 | `E_NOT_CONFIRMED` |
| B4.5 | 主 Agent 试图批准 | 拒绝：`task_approve` 不暴露给任何 Agent，CLI 也要求 TTY | `E_FORBIDDEN` |
| B4.6 | 主 Agent 发起确认请求 | 写 `~/.mo-agent/approvals/`，卡保持 `draft`，等人批准 | — |
| B4.7 | 批准前卡片被改 | 指纹不一致，批准作废，请求标 `stale` | `E_CARD_CHANGED` |

### 6.5 派单（B5）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B5.1 | 卡已 `confirmed` 且指派了可用执行者 | 派发 | — |
| B5.2 | 卡未确认 | 拒绝 | `E_NOT_CONFIRMED` |
| B5.3 | 指派的执行者不支持控制（无 `prompt`/无 CLI） | 返回可替代者 | `E_ASSIGNEE_UNSUPPORTED` |
| B5.4 | 指派者当前离线/繁忙 | 返回候选 + 建议 | `E_ASSIGNEE_BUSY` |
| B5.5 | `assignee: auto` 且设了默认执行者 | 用默认派发，回告名字 | — |
| B5.6 | `assignee: auto` 且没设默认 | 拒绝并提示 `mo worker use` | `E_NO_EXECUTOR` |
| B5.7 | 指定的执行者不存在/未装 | 拒绝并说明缺什么 | `E_NO_EXECUTOR` / `E_ASSIGNEE_UNSUPPORTED` |

> 设计变更（2026-11）：原计划"auto 自动挑选（空闲度/成功率/最近使用）"不做，改为**人设默认**（`mo worker use`）。理由：让 mo 猜谁来干活，猜错了代价比多打一行命令高。
| B5.8 | 超出预算（时间/token/子任务/重试） | 拒绝或转 `blocked` 问人 | `E_BUDGET` |
| B5.9 | 递归派单（执行者再派单） | 拒绝，深度上限 1 | `E_DEPTH` |
| B5.10 | 起进程/注入失败 | `failed`，可重试一次 | `E_DISPATCH_FAILED` |
| B5.11 | `workdir` 越出项目根 | 拒绝（无头与会话两种派单都校验） | `E_SCOPE` |

### 6.6 执行（B6）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B6.1 | 执行者请求审批 | 走现有 approvals，卡置 `blocked(waiting_approval)` | — |
| B6.2 | 执行者反问人 | `blocked(waiting_answer)`，推给人 | — |
| B6.3 | 超时无回执 | `blocked(timeout)`，问人：重试/换人/放弃 | `E_TIMEOUT` |
| B6.4 | 人取消 | 中断进程/会话，`canceled` | — |
| B6.5 | 执行者崩溃 | `failed`，保留 stdout/stderr | `E_EXECUTOR_CRASHED` |

### 6.7 回执（B7）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B7.1 | 回执文件存在且通过 schema + taskId 校验 | `verified: unverified`，进入 B8 | — |
| B7.2 | 进程退出 0，无回执 | `blocked(missing_receipt)`，不当作成功 | `E_NO_RECEIPT` |
| B7.3 | 回执 JSON 非法 / taskId 不匹配 | `blocked(bad_receipt)` | `E_BAD_RECEIPT` |
| B7.4 | 回执被多次写入 | 取最后一次，记 `amendment` 事件 | — |
| B7.5 | 只能从 stdout 抽取（无文件） | `verified: unverified` + 标记 `derived_from_stdout` | `W_DERIVED` |
| B7.6 | 回执 `status=blocked` 且 `needs` 非空 | `blocked` + `reason: needs_input`；`needs` / `deviations` 进收件箱、账本与 `task status` | — |

### 6.8 校验（B8）

`dispatch` 收到合法回执且 `status=done` 时，先由 core 复跑卡上的 `verify`，再决定终态。验收发生在写入终态**之前**，状态机没有 `done → blocked`。

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B8.1 | 全部 `verify` 项通过 | `done` + `verified: verified`，账本记 `task.verified` | — |
| B8.2 | 有支持项失败（含 `run` 超时、`check` 不成立） | `blocked(verify_failed)` + `verified: verify_failed`，账本记 `task.verify_failed`，问人重试/取消 | `E_VERIFY_FAILED` |
| B8.3 | 只有 `human` 项，或 `check` 无法判定 | `blocked(needs_human)`，`verified` 保持 `unverified` | — |
| B8.4 | 卡上 `verify` 为空 | 保持 `done` + `verified: unverified` | `W_NO_VERIFY` |
| B8.5 | `run` 项超时（默认 60s，`MO_VERIFY_TIMEOUT_MS` 可覆盖） | 按失败处理，`blocked(verify_failed)` | `E_VERIFY_FAILED` |
| B8.6 | 已 `done` 的卡人工重跑 `mo task verify <id>` | 只更新 `verified` 与账本，不改状态；失败时提示取消或重派 | — |

### 6.9 汇报（B9）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B9.1 | 主 Agent 可注入 | core 推一条摘要，触发新一轮 | — |
| B9.2 | 不可注入但可 hook | 走 hook 通道 | — |
| B9.3 | 都不可用 | 写 inbox，等主 Agent 主动 `inbox_pull` | `W_INBOX_ONLY` |
| B9.4 | 主 Agent 声称派发但账本无记录 | UI 标"未记录"，人可一键核对 | `W_UNRECORDED_CLAIM` |
| B9.5 | 主 Agent 转述结果与账本不一致 | 以账本为准，UI 展示机器结论 | — |

### 6.10 复盘与记忆（B10）

| 编号 | 条件 | 结果 | 错误码 |
|---|---|---|---|
| B10.1 | 回执带 `pitfalls` | 生成候选条目，等人确认 | — |
| B10.2 | 人纠正主 Agent 的做法 | `memory_propose` 一条偏好候选 | — |
| B10.3 | 候选缺触发条件 | 拒收 | `E_MEMORY_INVALID` |
| B10.4 | 候选与现有条目冲突 | 不自动覆盖，给出对比，等人裁决 | `E_MEMORY_CONFLICT` |
| B10.5 | 知识库不可用 | `memory_*` 全部返回错误，界面告警，**不静默返回空** | `E_MEMORY_UNAVAILABLE` |

## 7. 关键分支的细节

### 7.1 项目身份 vs 位置

- 身份 = `project.json.id`，随仓库提交；
- 位置 = 注册表里的 `paths[]`，可多个（worktree、备份、旧克隆）；
- 卡里只写 `project: p_<ULID>` 与**相对路径**；绝对路径只在派发那一刻拼出来；
- 账本里的历史路径**永不回写**。

### 7.2 派单信封（core 交给执行者的全部上下文）

```text
你是执行者。任务卡全文如下（路径仅用于回执）：
<card>

完成后必须：
1. 写回执到 /abs/.mo-agent/receipts/<taskId>.json（模板见下）
2. 逐条对照验收标准，填 verify
3. 输出一行 RECEIPT_WRITTEN <path>
缺任何一步视为未完成。

## 卡片附带的知识（自动注入）
- 偏好：<命中的 0-N 条>
- 避坑：<命中的 0-N 条>
```

卡**全文嵌入**，不依赖执行者去读文件；路径只用于回执落盘。

### 7.3 回执的最小合法形状

```json
{
  "taskId": "t_01HXYZ",
  "status": "done|partial|failed|blocked",
  "summary": "一句话结论",
  "artifacts": [{ "path": "app/web/tasks.html", "kind": "file" }],
  "verify": [{ "cmd": "npm test -- --filter tasks", "exit": 0 }],
  "deviations": ["..."],
  "pitfalls": [{ "symptom": "", "trigger": "", "cause": "", "fix": "" }],
  "needs": ["..."]
}
```

校验规则：`taskId` 必须匹配；`status` 必须在枚举内；`status=done` 时 `verify` 不得为空且不得含失败项。

### 7.4 主 Agent 的权限边界

| 能做 | 不能做 |
|---|---|
| `task_create` / `task_dispatch` / `task_status` | 确认任务卡（无 `task_confirm`） |
| `ledger_query` / `memory_recall` | 写账本、删记忆 |
| `memory_propose` | 改已有记忆、改自己的契约 |
| `inbox_pull` | 执行、写文件、起进程 |

## 8. 错误码一览

| 码 | 含义 | 谁处理 |
|---|---|---|
| `E_PROJECT_UNBOUND` / `E_PROJECT_AMBIGUOUS` / `E_PROJECT_NOT_FOUND` / `E_PROJECT_MISSING` | 项目解析失败 | 主 Agent 问人 |
| `E_CONFIRM_REQUIRED` | 需要人确认 | 人 |
| `E_CARD_INVALID` / `E_CARD_TOO_LARGE` | 卡不合法 | 主 Agent 修 |
| `E_NOT_CONFIRMED` / `E_FORBIDDEN` | 越权/跳步 | 拒绝 |
| `E_CARD_CHANGED` | 批准前卡片被改，批准作废 | 人重新发起 |
| `E_ASSIGNEE_*` / `E_NO_EXECUTOR` | 执行者不可用 | 人定 |
| `E_BUDGET` / `E_DEPTH` / `E_SCOPE` | 约束 | 拒绝 |
| `E_DISPATCH_FAILED` / `E_EXECUTOR_CRASHED` / `E_TIMEOUT` | 执行异常 | core 重试/升级 |
| `E_NO_RECEIPT` / `E_BAD_RECEIPT` | 回执异常 | core 判 blocked |
| `E_VERIFY_FAILED` / `E_VERIFY_TIMEOUT` | 验收失败 | 人决定重试 |
| `E_MEMORY_*` / `E_MEMORY_UNAVAILABLE` | 记忆异常 | 人 |

## 9. 接口

同一套 backend，两种传输。**CLI 是通用底座，MCP 是增强。**

| 操作 | CLI | MCP |
|---|---|---|
| 建卡 | `mo task create --project . --title ... --json` | `task_create` |
| 发起确认请求 | `mo task confirm t_x` | `task_confirm`（只发请求） |
| 批准 / 拒绝 | `mo task approve\|reject t_x` | **不暴露给任何 Agent** |
| 待批列表 | `mo task requests` | — |
| 移除项目登记 | `mo project remove <名称\\|路径> [--purge]` | — |
| 派单 | `mo task dispatch t_x --exec "claude -p"` | `task_dispatch` |
| 状态 | `mo task status t_x` | `task_status` |
| 收件箱 | `mo inbox pull` | `inbox_pull` |
| 账本 | `mo ledger query --project p_x --days 7` | `ledger_query` |
| 检索 | `mo memory recall "…"` | `memory_recall` |
| 提案 | `mo memory propose --file -` | `memory_propose` |
| 派单执行 | — | — |
| 提交回执 | `mo receipt submit t_x --file -` | `receipt_submit`（可选） |

MCP 传输：Streamable HTTP（`/mcp`，复用本机令牌）；需要 stdio 时用 `mo mcp` 薄壳转发。stdio 薄壳已落地（`cli/commands/mcp.mjs`），HTTP 传输未做。

CLI 入口是 [`cli/mo.mjs`](../../cli/mo.mjs)，`npm link` 后命令名即为 `mo`。CLI 一列全部可用；MCP 一列目前只有 stdio 薄壳 `mo mcp`（工具名与上表一致，`task_confirm` 与 `memory_accept` 不暴露），Streamable HTTP 未做。

## 10. 数据格式

### project.json（提交进仓库）

```json
{ "id": "p_01H9ABC", "name": "mo-agent", "created": "2026-10-23T10:00:00+08:00" }
```

### 任务卡

```yaml
---
id: t_01HXYZ
project: p_01H9ABC
title: 任务面板加筛选
created: 2026-10-23T10:12:00+08:00
from: dsh:main
assignee: auto
workdir: .
verify:
  - run: npm test -- --filter tasks
  - check: app/web/tasks.html 含 filter-bar
  - human: 视觉确认
receipt: .mo-agent/receipts/t_01HXYZ.json
timeout: 45m
retries: 1
on_fail: ask_human
budget: { runtime: 45m, tokens: 200000, children: 0 }
---
## 背景
## 交付物
## 边界（不要做）
## 约束
```

### 账本条目（append-only）

```json
{ "v": 1, "at": "2026-10-23T10:12:03+08:00", "machine": "m_01H", "project": "p_01H9ABC",
  "taskId": "t_01HXYZ", "type": "task.dispatched", "actor": "core", "payload": { "assignee": "claude-code" } }
```

事件类型最小集：`task.created` / `task.confirmed` / `task.dispatched` / `task.blocked` / `task.completed` / `task.failed` / `task.canceled` / `receipt.received` / `receipt.amended` / `memory.proposed` / `memory.accepted`。

## 11. 约束

| 约束 | 机制 |
|---|---|
| 派单必须先确认 | 状态机（`task_dispatch` 只接受 `confirmed`） |
| 主 Agent 不能自我确认 | 不暴露 `task_confirm` |
| 不能递归派单 | 执行者工具集无 `task_dispatch`；core 校验 depth ≤ 1 |
| 不能越界写 | `workdir` 必须在项目根内 |
| 不能无上限跑 | 卡上的 `budget` + 全局并发/频率限制（**字段已存在，尚未执行**，见 §12.7） |
| 不能改账本 | 账本只由 core 追加，无写接口 |
| 不能静默丢记忆 | 知识库不可用时返回错误，不返回空 |

## 12. 落地阶段

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **P0** | `project.json` 认领 + 卡/回执格式 + `mo task create\|dispatch\|status` + 账本 | 一条任务从建卡到 `done`，账本可查 | ✅ 已落地（`cli/` + `core/tasks/`） |
| **P1** | 主 Agent 接入：skill + CLI + `mo mcp`（HTTP 传输未做） | 任意 Agent 接入后能跑完一轮 | 🟡 skill / stdio MCP / `mo agent describe` / `agent add --mcp` / `inbox pull --wait` 已落地；HTTP 传输未做 |
| **P2** | `verify` 执行器 + `blocked` 升级（含 watchdog） | 失败/超时能正确转给人 | ✅ 已落地（`cli/lib/verify.mjs` + `mo task verify` + `mo watchdog run`） |
| **P3** | `memory_recall` 注入 + `memory_propose` + 候选区 | 避坑条目在一次派单中被自动带上 | ✅ 已落地（`core/knowledge/` + `mo memory`：recall 注入、propose、候选区、冲突裁决） |
| **P4** | 面板/手机端展示 + `mo manager check` | 换主 Agent 后仍可继续 | ⬜ 未开始 |

### 12.1 P0 实现记录

- `core/tasks/`：状态机（`model.mjs`）、卡解析/渲染（`card.mjs`）、回执校验（`receipt.mjs`）、账本事件（`ledger.mjs`），全部纯逻辑；
- `cli/`：`project|task|receipt|ledger|run|doctor` 六个命令，全部 IO 集中在这里；
- 派单协议：卡全文走 stdin + `MO_TASK_ID / MO_PROJECT / MO_PROJECT_ROOT / MO_RECEIPT` 环境变量；
- 账本：`~/.mo-agent/ledger/YYYY-MM.jsonl`，按 taskId 可查；
- 测试：`core/tasks/*.test.mjs` + `cli/*.test.mjs`，含端到端建卡→派单→done（具体数量不写死，看 `npm test` 输出）。

**已知偏差**：P0 期间 `verified` 一律为 `unverified`；P2 已补上 `verify` 自动执行（`cli/lib/verify.mjs`），收到 `status=done` 的回执后由 core 决定 `done` / `blocked`。

### 12.2 P3 召回与注入实现记录（2026-11）

**已落地**：知识库解析、召回打分、派单信封注入、收件箱兜底（B9.3 的 pull 一侧）。

| 内容 | 位置 |
|---|---|
| 条目解析（`## 标题` 切段、`- trigger:` / `- tags:` 元数据） | `core/knowledge/entry.mjs` |
| 召回打分（标题 4 / trigger·tags 3 / 正文 1，中文按二元组切词） | `core/knowledge/recall.mjs` |
| 目录解析与错误映射（B10.5 / I9） | `cli/lib/knowledge.mjs` |
| `mo memory recall\|list\|init\|path` | `cli/commands/memory.mjs` |
| 派单注入（§7.2 的「卡片附带的知识」） | `cli/lib/dispatch.mjs` → `cli/lib/envelope.mjs` |
| 收件箱写入与拉取（B9.3） | `cli/lib/inbox.mjs` + `cli/commands/inbox.mjs` |

**目录命名**：数据放 `~/.mo-agent/memory/`，与 `mo memory` 命令对齐；老版本的 `knowledge/` 仍然可读（带 `W_MEMORY_LEGACY_DIR`），用 `mo memory migrate` 搬过去。`MO_AGENT_MEMORY` 覆盖路径，`MO_AGENT_KNOWLEDGE` 作为旧变量兼容。

**条目格式**（人写笔记的习惯，不做 YAML 依赖）：

```markdown
## 派单超时不要直接重试

- trigger: 派单, 超时, retry
- tags: 任务

先看 mo task logs，确认是执行者卡住还是回执没写。
```

- 一个 `## 标题` 就是一个条目；没有二级标题时整个文件算一条，标题取 `# 一级标题` 或文件名；
- `trigger` / `tags` 只用于加权，正文与标题同样参与匹配；
- 文件名以 `_` 开头（如 `_template.md`）不参与召回，可放模板；
- 无索引、无缓存，改完立即生效。

**降级规则**：

- `mo memory *` 读不到知识库 → `E_MEMORY_UNAVAILABLE`，不静默返回空（B10.5）；
- 派单时召回失败 → 不挡派单，stderr 打 `W_MEMORY_UNAVAILABLE`，`--json` 里 `knowledge.ok=false`；
- 默认路径 `~/.mo-agent/memory` 不存在 → `W_MEMORY_EMPTY` 并提示 `mo memory init`；`MO_AGENT_MEMORY` 显式指定却不存在 → 直接报错；
- 注入条数由 `MO_RECALL_LIMIT` 控制（默认 5，上限 20）。

**记忆回流（B10.1–B10.4）**：

| 动作 | 命令 | 行为 |
|---|---|---|
| 提案 | `mo memory propose --file -\|--title …` | 校验（缺 trigger → `E_MEMORY_INVALID`），与现有条目比对，落 `candidates/` |
| 查看 | `mo memory candidates` | 列出待裁决候选，冲突的直接标出来 |
| 采纳 | `mo memory accept <id>` | 再次比对；冲突则 `E_MEMORY_CONFLICT` 拒写并给新旧对比；通过则写进知识库文件 |
| 丢弃 | `mo memory reject <id>` | 删候选，不进账本 |

- `B10.1`：回执里带 `pitfalls` 时自动生成候选（`source: receipt`），**不直接写知识库**；缺 trigger 的按 `W_MEMORY_INVALID` 拒收并汇报；
- `B10.4`：同 scope 同标题、或正文重合度 ≥ 0.6 判为冲突，只提示不覆盖；
- 账本记 `memory.proposed` / `memory.accepted`，被拒的候选不留账。

**仍未做**：知识库不可写时的界面告警、`blocked` 主动推送（现在只能靠 `mo inbox pull` 或被动查 `status`）。

### 12.3 P1 MCP stdio 薄壳记录（2026-11）

`mo mcp` 是一个**转发器**：每个工具调用都变成一次 `mo <path> --json` 子进程，不在 MCP 层重写业务逻辑，所以 CLI 与 MCP 的行为永远一致。

| 工具 | 落到 |
|---|---|
| `task_create` | `mo task create … --json` |
| `task_confirm` | `mo task confirm <id> --json`（只发起请求；客户端支持 elicitation 时顺带弹表单） |
| `task_dispatch` | `mo task dispatch <id> --json`（无头：前台等待；会话型：立即返回 `running`） |
| `task_status` | `mo task status <id> --json` |
| `inbox_pull` | `mo inbox pull --json` |
| `ledger_query` | `mo ledger query … --json` |
| `memory_recall` | `mo memory recall … --json` |
| `memory_propose` | `mo memory propose --file - --json`（走 stdin 传 JSON） |

**刻意不暴露**：`task_approve` / `task_reject`（B4.5，批准权属于人）、`memory_accept`（B10.4，裁决属于人）、`receipt_submit`（回执属于执行者）。`task_confirm` 暴露，但它只发起请求，不改变状态。

传输沿用 MCP stdio 约定：一行一条 JSON-RPC，日志只走 stderr；支持 `initialize` / `tools/list` / `tools/call` / `ping`，未知方法与坏 JSON 分别回 `-32601` / `-32700`。工具失败不回 JSON-RPC error，而是 `isError: true` + 文本（与 `mo` 的 `[E_CODE]` 输出一致）。

**未做**：Streamable HTTP `/mcp`、`mo agent add <agent>` 写各家 MCP 配置、tool 级权限与审计。

### 12.4 主 Agent 接口层（2026-11）

**一条原则**：mo 不认识任何具体 Agent。接入只有三种可粘贴物 + 一个可等待的收件箱。

| 件 | 命令 | 说明 |
|---|---|---|
| 契约 | `mo agent describe --json` | 工具清单 / 禁止项 / 铁律，机器可读 |
| 契约 | `mo agent describe [--json\|--prompt\|--skill]` | 概览 / 机器可读 / 可粘贴文本，都是 `core/manager/contract.mjs` 的渲染 |
| 接入 | `mo agent add --mcp <file>` | 合并 `mcpServers`，幂等 + `.bak-<时间>` 备份 |
| 接入 | `mo agent add --prompt` | 打到 stdout，自己贴到没有配置文件的地方 |
| 唤醒 | `mo inbox pull --wait 60s` | 有就立刻返回，没有就等到超时；不依赖推送与 hook |
| 身份 | `mo task create --from <id>` / `MO_AGENT_ID` | 写进卡片 `from` 与账本 `task.created.payload.from` |

**渲染矩阵**：五份产物里，**行为段（边界 / 流程 / 铁律 / 失败表）逐字相同**，只有包装不同；`contract.test.mjs` 会断言 skill 与 prompt 的行为段完全一致，防止再次分叉。

| 格式 | 入口 | 落在哪 |
|---|---|---|
| `skill` | `mo skill install` | 技能目录（与 `skills/mo/SKILL.md` 逐字节一致） |
| `prompt` | `mo agent describe`（默认）/ `mo agent add --prompt` | 粘进 Agent 的系统提示 |
| `agent-block` | `mo project init` / `mo project agent --mode inline` | `<repo>/AGENTS.md` |
| `mo-doc` | `mo project init --mode ref` | `.mo-agent/MO.md` |
| `pointer` | `mo project init`（技能已装时） | `AGENTS.md` 里的一句指针 |

后三种是**落盘 payload**，不是给人对着终端读的——它们本来就靠"指向技能或 MO.md"补全细节，所以 `mo agent describe` 只暴露前两种；直接打印短块会得到一段没有上下文的话。

**文案真源**：`core/manager/contract.mjs`。`skills/mo/SKILL.md`、`AGENTS.md` 内联块、`.mo-agent/MO.md`、`--prompt` 全部由它渲染，`scripts/gen-skill.mjs` 负责生成 SKILL.md 与代码内联副本。`core/manager/contract.test.mjs` 会拦住两类腐化：工具漏写、文案里写死 Agent 名字。

**确认权（B4）**：

| 动作 | 谁 | 怎么保证 |
|---|---|---|
| 发起请求 | 任何 Agent | `mo task confirm`，只写 `approvals/`，状态不变 |
| 批准（终端） | 人 | `mo task approve` 要求 TTY（`--yes` 是显式逃生口），校验卡片指纹 |
| 批准（网页/手机） | 人 | `POST /api/task-approvals/<id>`，设备令牌鉴权，账本记 `channel: web`，同样校验指纹 |
| 批准（MCP 表单） | 人 | 客户端声明 `capabilities.elicitation` 时，`task_confirm` 走 `elicitation/create` 弹表单；账本记 `channel: mcp-elicitation` |
| 拒绝 | 人 | `mo task reject`，卡保持 `draft` |

指纹 = `sha256(标题 + 正文 + 验收 + workdir + timeout …)`，不含状态与时间。批准时指纹不一致 → `E_CARD_CHANGED`，请求标 `stale`，防止"批准完再偷改卡"。

**审批通道**：终端 `mo task approve` 与网页 `/api/task-approvals` 写的是**同一个决定文件**（`~/.mo-agent/approvals/<id>.json`），所以两边看到的请求一致、批准后另一侧立即失效。

**MCP elicitation（form mode）**：客户端在 `initialize` 里声明 `capabilities.elicitation` 时，`task_confirm` 先落请求，再发 `elicitation/create`（enum：approve / reject），用户的选择直接回到 mo：

- `accept` + `approve` → `applyDecision(channel: "mcp-elicitation")`；
- `accept` + `reject` → 拒绝，卡留 draft；
- `decline` / `cancel` / 5 分钟超时 → **保持 pending**，不视为通过；
- 客户端没声明能力，或设了 `MO_ELICITATION=0` → 回退到 pending + 终端/网页。
- 信任级别：表单由客户端代传，属于**便利通道**，不是带外边界；账本里的 `channel` 就是为区分这个。

**仍未做**：daemon 启动时补推 pending 请求、审批页之外的推送渠道、Streamable HTTP `/mcp`。

### 12.5 watchdog（2026-11）

会话型派单立即返回，没有进程可以等——回执不来，卡就永远停在 `running`。B6.3 的「超时无回执」需要一个主动巡检：

| 做什么 | 不做什么 |
|---|---|
| 扫 `running` / `dispatched`，超过卡上 `timeout`（默认 45m）→ `blocked(timeout)` | 不杀进程（会话型窗口不归 mo 管） |
| 账本 `task.blocked`（payload 带 `reason`、`elapsedMs`、`session`） | 不自动重试、不换人 |
| 收件箱一条「超过 N 分钟没有回执」 | 不猜"是不是还在干活"（没有心跳） |
| 顺带 `expireOverdue`：过期审批请求 → `expired` | 不碰终态卡 |

入口：`mo watchdog run [--project …] [--all] [--dry-run]`，可挂 cron/launchd。`mo inbox pull --wait` 在等待循环里每 30 秒也扫一次当前项目，所以"等通知"时超时不会漏。

### 12.6 会话型执行者（2026-11）

无头 worker（`claude -p`）适合 CI 与批量，但过程对人不可见。会话型 worker 补的是这个：

| | 无头 | 会话 |
|---|---|---|
| 启动方式 | mo 起子进程，stdin 传卡 | 新终端窗口跑交互式 CLI |
| 人能看到 | 只有实时 stderr 日志 | 整个会话，可随时插话 |
| 回执 | 子进程退出后收 | 只能等它自己写文件 |
| dispatch | 前台等进程 | **立即返回**，结果靠回执文件 |
| 超时 | 进程超时 | 等不到回执 → `blocked(timeout)` |

命名：**裸名 = 会话型**（`claude` / `codex` …），`-headless` 后缀 = 无头型（`claude-headless` …）。老卡片没有 `session` 字段时按无头解释，避免同名升级后行为变化。

实现：`mo worker add <名> --session --command '<交互式命令>'`。派单时把卡写成 `.mo-agent/envelopes/<id>.md`，再生成 `.mo-agent/runs/<id>.sh`，然后开新终端窗口执行。终端由 `mo terminal list|add|remove|use` 管理（内置 iterm / terminal / print / none，自定义存 `~/.mo-agent/terminals.json`），设了默认就一直用它；一次性覆盖用 `MO_TERMINAL` / `MO_LAUNCH_CMD`，`MO_LAUNCHER=print` 只生成不启动。

### 12.7 实现现状与缺口（2026-11 对照）

**已实现**：项目认领（B1/B2）、建卡（B3.1/3.2/3.4）、确认与三种审批通道（B4.1–4.7）、派单（B5.1/5.2/5.3/5.10/5.11）、执行超时（B6.3 watchdog）、回执（B7.1/7.2/7.3/7.5/7.6）、验收（B8.1–8.6）、收件箱（B9.3）、记忆（B10.1–10.5）、会话型 worker 与终端配置、MCP stdio 薄壳、契约单一真源。

**只有设计、还没有代码**：

| 编号 | 内容 | 缺什么 |
|---|---|---|
| B3.3 | 建卡时提示"另有 N 个进行中" | `W_TASKS_IN_FLIGHT` 未实现 |
| B3.5 | 疑似重复卡提示 | `W_POSSIBLE_DUP` 未实现 |
| B5.4 | 执行者忙/离线 | 无空闲度概念，`E_ASSIGNEE_BUSY` 未实现 |
| B5.5–B5.7 | `assignee: auto` 的解析 | **已落地**：`mo worker use` 设默认，auto 卡派单用它；没设默认时建卡告警、派单 `E_NO_EXECUTOR` 并提示。不做"按空闲度/成功率自动挑" |
| B5.8 | 预算（时间/token/子任务/重试） | 卡上有 `budget` 字段，没人读；`E_BUDGET` 未实现 |
| B5.9 | 递归派单深度上限 | 靠"不把 `task_dispatch` 暴露给执行者"挡住，没有 `E_DEPTH` 校验 |
| B6.1/B6.2 | 执行者请求审批 / 反问人 | 无 `blocked(waiting_approval)` / `waiting_answer`；`needs` 只能单向上报，回答要重派 |
| B7.4 | 回执多次写入 | 后一次直接覆盖，没有 `amendment` 事件 |
| B9.4 | 声称派发但账本无记录 | `W_UNRECORDED_CLAIM` 未实现（依赖 UI） |
| I10 | CLI 与 daemon 版本不一致 | 无版本握手 |

**命令缺口**（§13 里承诺、当前不存在）：

| 承诺 | 现状 |
|---|---|
| `mo daemon start` | 不存在；daemon 只能由桌面端拉起（纯 CLI 形态还跑不起来） |
| `mo manager check` | 不存在；用 `mo doctor` + 手工建一张卡验证 |
| `mo agent remove` | 不存在；手工改各家 MCP 配置 |
| `mo doctor --preflight` | 不存在；`mo doctor` 本身已是只读 |

**服务层**：任务面板（只有审批页与监控页）、daemon 启动补推 pending 审批、审批推送（现在 5s 轮询）、Streamable HTTP `/mcp`、账本轮转与保留期、Windows/Linux 适配、知识库不可写的界面告警。

### 12.8 全局配置与首次装配实现记录（2026-11）

**配置文件**：`~/.mo-agent/config.json`（`MO_AGENT_CONFIG` 覆盖路径）。

优先级：`DEFAULTS < config.json < 环境变量 < 命令行参数`；argv 只对 daemon 有意义，CLI 侧 `mo config list` 只显示 `default | file | env`。

| 键 | 类型 | 默认 | 谁用 | 环境变量 |
|---|---|---|---|---|
| `host` | string | `0.0.0.0` | daemon | `MO_AGENT_HOST` |
| `port` | 1–65535 | `7788` | daemon | `MO_AGENT_PORT` |
| `authRequired` | boolean | `true` | daemon | `MO_AGENT_AUTH_REQUIRED`（兼容 `MO_AGENT_NO_AUTH=1`） |
| `pollMs` | ≥ 100 | `1500` | daemon | `MO_AGENT_POLL` |
| `logLevel` | debug/info/warn/error | `info` | daemon | `MO_AGENT_LOG_LEVEL` |
| `recallLimit` | 0–20 | `5` | CLI 派单注入 | `MO_RECALL_LIMIT` |
| `memoryPath` | string | 空（默认目录） | CLI | `MO_AGENT_MEMORY` |

**行为**：

- 文件不存在 → 静默用默认；坏 JSON / 字段非法 → stderr 一行 `[W_CONFIG]` 警告并继续（`host/config.mjs`），CLI 侧把警告收进 `readGlobalConfig().warnings`。
- `mo config list|get|set|unset`：`set` 校验类型与范围（非法值 `E_USAGE` + 范围提示），只写 `config.json`，不碰环境变量与 shell rc；`unset` 删键回默认；`list --json` 输出 `{ config: [{ key, value, source, default }] }`。
- CLI 接入：召回条数 `MO_RECALL_LIMIT > config.recallLimit > 5`；记忆库 `MO_AGENT_MEMORY > config.memoryPath > ~/.mo-agent/memory`（旧 `MO_AGENT_KNOWLEDGE` / `knowledge/` 兼容不变）。
- `mo setup`：见 §13.4；连跑第二次每步都是 `skipped`，`--dry-run` 不写任何文件。
- 默认执行者 / 终端仍然只存在 `workers.json` / `terminals.json`，不在 `config.json` 里存第二份；`pin` 等密钥不进配置文件。

**测试**：`host/config.test.mjs`（优先级链 + 坏文件容错）、`cli/config.test.mjs`、`cli/setup.test.mjs`（空 home、幂等、`--dry-run`、`--only`/`--skip`、不碰项目）。

**仍未实现**：`mo setup cli`、`mo daemon start`、`mo manager check`、`mo doctor --preflight`、`mo agent remove`（见 §12.7）。

## 13. 安装与首次使用

### 13.1 三种形态，一个 daemon

| 形态 | 适合 | 启动 |
|---|---|---|
| **桌面端**（推荐） | 日常使用 | 菜单栏常驻，随登录启动，无窗口 |
| **纯 CLI** | 无 GUI / 服务器 | `mo daemon start`（**未实现**，见 §12.7）或 launchd plist |
| **混合** | 实际最常用 | 桌面端常驻，终端里的 `mo` 连同一个 daemon |

无论哪种，**只有一个 daemon 实例**，由 `~/.mo-agent/desktop.lock` 保证；`mo` 只是它的客户端。

### 13.2 前置条件

| 条件 | 必需性 | 缺失时 |
|---|---|---|
| macOS 12+（Linux/Windows 适配中） | 必需 | 无法安装 |
| Node ≥ 18 | `mo` CLI 与 hooks 需要 | `mo setup` 只检查不代装，按提示自己装或换桌面端自带运行时 |
| 一个主 Agent（DSH / Claude Code / …） | 建议 | 仍可用 CLI 手工建卡派单 |
| 一个 git 仓库 | 可选 | 非 git 目录需显式 `mo project init` |

### 13.3 首次使用的七步

> 本节是**目标形态**：`mo setup` 已实现（§12.8 / §13.4），`mo setup cli` / `mo doctor --preflight` / `mo manager check` 仍未实现（见 §12.7）。
> 当前可用：`scripts/install-cli.sh` 装 CLI、`mo setup` 装配、`mo doctor` 自检、桌面端拉起 daemon。

```bash
# 1. 安装桌面端：下载 .app → 拖进 Applications → 首次打开
#    启动自检页只检查 Node / 端口 / 权限，只报告不写入

# 2. 安装 CLI（桌面端「设置」里也有一个按钮）
mo setup cli            # 写入 /usr/local/bin/mo 或回退 ~/.local/bin

# 3. 环境检查（只读）
mo doctor --preflight

# 4. 初始化
mo setup                # 交互式；--yes 走默认

# 5. 接入主 Agent
mo agent add dsh        # 写入 MCP 配置 + manager 契约
mo agent add claude-code # 或按需

# 6. 认领第一个项目
cd ~/c/work/foo && mo project init .

# 7. 验证
mo doctor
mo manager check        # 冒烟：建卡 → 派单 → 读回执
```

第 1、2 步是唯一需要"手动"的两步；从第 3 步起全部可重复执行，不会破坏已有配置。

### 13.4 `mo setup` 实际做什么（幂等，2026-11 落地）

实现：`cli/commands/setup.mjs`，只串已有命令/函数，不重写逻辑。**不碰仓库、不启动 daemon、不装 Node、不动 PATH**；单步失败不中断其它步。

| # | 步骤 | 检测 | 动作 |
|---|---|---|---|
| 1 | 数据目录 | `~/.mo-agent/` 及各子目录 | 建 `ledger/ memory/ inbox/ approvals/` |
| 2 | 全局配置 | `config.json` 存在 | 只补缺的默认键，已有值不动；坏 JSON / 非法字段给警告 |
| 3 | 记忆骨架 | `memory/README.md` 等 | 只补 `README.md`、`preferences.md`、`pitfalls/_template.md`、`decisions/_template.md` |
| 4 | 默认执行者 | `defaultWorkerName()` 非空 | 列已安装的内置 worker，`--yes` 取第一个，交互时让选 |
| 5 | 默认终端 | `currentTerminal()` 非空 | 探测 iTerm → Terminal.app；都没有就设 `print` 并 `⚠` |
| 6 | 技能 | 目标目录里已有 `mo/SKILL.md` | 调 `mo skill install` 的写入函数；非 TTY 且没给 `--yes` 时跳过并说明 |
| 7 | MCP | 已知配置文件里已有 `mo` / `mo-agent` 条目 | 合并 `mcpServers`（写前备份）；找不到配置就跳过，不猜路径 |
| 8 | 汇总 | — | 跑 `doctor` 检查项，打印剩余动作 |

选项：`--yes`（不问）、`--dry-run`（不写任何文件）、`--only dirs,memory`、`--skip skill`、`--json`（每步 `status`）。退出码：有 `⚠` / `✗` 为 1，否则 0。

交互（TTY 且没给 `--yes`）：可以选默认执行者、终端、技能目标，并确认是否写 MCP。`--dry-run` 交互时按步骤分页展示——每步之后「按 Enter 继续...」，最后问「按这个计划真实执行吗 (y/N)」，答 y 才用同一批选择真实落地；`--json` 不弹任何问题。

每步在人类可读输出里都会列出真实操作与具体路径（目录、文件、`mo worker use` / `mo terminal use` 的目标、MCP 服务名与备份文件）；`--dry-run` 只是把这些操作"不落地"，输出格式与真实执行一致。

**刻意没做**（与旧版设想的差距）：`mo setup cli`（装 CLI 仍用 `scripts/install-cli.sh`）、端口占用时顺延、单实例锁检查、自动把 `mo` 装进 PATH、主 Agent 配置的版本号更新，以及"失败回滚"——每步只做最小幂等写入，冲突时跳过而不是回滚。

### 13.5 首次使用生成的东西

```
~/.mo-agent/
├── config.json                # 全局键：host/port/authRequired/pollMs/logLevel/recallLimit/memoryPath
├── memory/                    # 空骨架 + 模板
├── ledger/                    # 空目录
├── projects.json              # {}
├── scratch/tasks/             # 空
└── （原有）devices.json 等    # 若桌面端已初始化则保留
```

项目侧只会在**首次建卡或 `mo project init`** 时写入 `.mo-agent/`，安装阶段不碰任何仓库。

### 13.6 首次使用的分支

| 编号 | 条件 | 结果 | 提示 |
|---|---|---|---|
| I1 | `~/.mo-agent/` 已存在且有 devices.json | 判定为升级，只补缺 | "检测到已有安装，跳过初始化" |
| I2 | 无 Node | CLI 不可用，桌面端仍可跑 | 引导安装 node 或用内置运行时 |
| I3 | 无写 `/usr/local/bin` 权限 | 回退 `~/.local/bin` | 提示把该目录加进 PATH |
| I4 | 端口被占用 | 顺延一个空闲端口并写回 config | "使用 8788" |
| I5 | 已有 daemon 在跑（锁存在） | 复用，不重复起 | — |
| I6 | 主 Agent 已配过 mo-agent MCP | 更新版本，保留其它配置 | 备份 `.bak-<时间>` |
| I7 | 主 Agent 不支持 MCP | 只写 CLI 契约（CHARTER / CLAUDE.md） | "降级为 B 档，结果需手动拉取" |
| I8 | 当前目录不是 git 仓库 | 不自动认领 | 提示 `mo project init .` |
| I9 | 知识库路径不可写 | 启动但不静默：`memory_*` 返回 `E_MEMORY_UNAVAILABLE` | 界面告警 |
| I10 | CLI 与 daemon 版本不一致 | 拒绝调用并提示升级 | "CLI 0.3.0 / daemon 0.2.0" |

### 13.7 五分钟金路径（验收首次使用是否成功）

1. `mo doctor` 全绿；
2. 在项目目录里对主 Agent 说："给这个项目加一个 README 的安装章节"；
3. 主 Agent 回显任务卡，你确认；
4. 看到执行者开始干活；
5. 十分钟内收到一条"完成 + 验收通过"；
6. 打开 `~/.mo-agent/ledger/` 能看到对应记录；
7. 在项目里 `git status` 能看到 `.mo-agent/tasks/` 下的卡。

**七条全过，才叫装好了。** 任何一条失败，用 `mo doctor` 定位。

### 13.8 卸载与重置

| 动作 | 命令 | 影响 |
|---|---|---|
| 卸载 CLI | `mo setup cli --uninstall` | 只删 `mo` 软链 |
| 断开主 Agent | `mo agent remove dsh`（**未实现**，先手工改 MCP 配置） | 只删 mo-agent 写入的 MCP 条目，备份保留 |
| 清空个人数据 | 手动 `rm -rf ~/.mo-agent` | 偏好、避坑、账本全丢，需二次确认 |
| 移除项目接入 | `rm -rf <repo>/.mo-agent` | 只影响该项目，不影响其它项目 |
| 完整卸载 | 拖走 .app + 手动删 `~/.mo-agent` | 文档里明写，因为系统卸载器不认识它 |

**默认不提供"一键清空"**，账本和记忆是不可再生资产。

## 14. 未决

1. 回执是否进 git（建议默认 ignore，可选提交摘要版）；
2. 账本轮转与保留期；
3. 记忆检索后端：已按内置纯文本落地（§12.2）；qmd 作为可选后端仍待评估；
4. ~~`assignee: auto` 的排序权重~~ → 已决定不做自动挑选，改为 `mo worker use` 显式默认（§6.5）；
5. 人不在场时，`blocked` 的默认超时与升级路径（手机推送？）；
6. 主 Agent 的工具隔离在 DSH 侧的具体配置方式；
7. 跨平台（Windows）：暂不支持，方案与差距见 [cli-cross-platform.md](../plans/cli-cross-platform.md)，与桌面端跨平台一并处理。