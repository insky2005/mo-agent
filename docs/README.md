# 文档导航

Mo Agent 的全部文档。先看「怎么读」，再按需跳转。

## 怎么读

| 你是 | 建议顺序 |
|---|---|
| 想了解这是什么产品 | [README](../README.md) → [architecture.md](architecture.md) → [adr/](adr/) |
| 要接入一个新 Agent | [architecture.md](architecture.md) §6 → [adapters/README.md](../adapters/README.md) → [reference/capabilities.md](reference/capabilities.md) |
| 要改事件 / 状态 / 通知 | [spec/event-contract.md](spec/event-contract.md) → [adr/adr-0003](adr/adr-0003-event-contract.md) |
| 要用或排障 | [guides/agent-hooks.md](guides/agent-hooks.md)、[guides/voice.md](guides/voice.md) |
| 在做 workbench（个人工作台） | [spec/workbench-flow.md](spec/workbench-flow.md) |

## 目录

```
docs/
├── architecture.md     总览：分层、依赖方向、新增代码放哪
├── adr/               决策记录（只增不改）
├── spec/              设计与契约（生效中）
├── guides/            操作手册（面向使用者）
├── reference/         查表类资料（含生成物）
├── plans/             任务书与方案（历史，多数已落地）
├── research/          预研（结论在 reference/，证据在这里）
├── assets/            文档用图
├── private/           内部资料（gitignore）
└── raw/               原始凭据/资料（gitignore）
```

### adr/ — 决策记录

| 文档 | 结论 |
|---|---|
| [adr-0001-observational-first.md](adr/adr-0001-observational-first.md) | 观察优先，暂不做 ACP 托管 |
| [adr-0002-hands-free-voice.md](adr/adr-0002-hands-free-voice.md) | 免手操作：语音优先、耳机直连 |
| [adr-0003-event-contract.md](adr/adr-0003-event-contract.md) | 一套规范事件 + 显式映射表 + 契约测试 |

### spec/ — 设计与契约

| 文档 | 状态 | 内容 |
|---|---|---|
| [event-contract.md](spec/event-contract.md) | ✅ 生效（M1–M4 已落地） | 事件词汇表、状态语义、映射责任、接入清单 |
| [dingtalk-bot.md](spec/dingtalk-bot.md) | ✅ 生效 | 钉钉 Stream 通道、消息形态、配置 |
| [workbench-flow.md](spec/workbench-flow.md) | 🟡 P0 已落地（CLI） | 个人工作台：任务流转、分支、安装 |

### guides/ — 操作手册

| 文档 | 内容 |
|---|---|
| [agent-hooks.md](guides/agent-hooks.md) | 一键配置各家 Agent 的 hooks：写什么、怎么回退、安全边界 |
| [voice.md](guides/voice.md) | 语音批准与口述：用法、口令、排障 |

### reference/ — 查表

| 文档 | 来源 | 内容 |
|---|---|---|
| [capabilities.md](reference/capabilities.md) | ⚙️ 由 profile 生成，勿手改 | 各 Agent 的观测/批准/控制能力 |
| [agent-adaptation-matrix.md](reference/agent-adaptation-matrix.md) | 人工维护 | 全量 Agent 适配性（含未接入、不可行、证据级别） |
| [notification-matrix.md](reference/notification-matrix.md) | 人工维护 | 事件 → 通道 → 优先级 |
| [claude-code-notifications.md](reference/claude-code-notifications.md) | 人工维护 | Claude Code 的 Notification 类型与文案 |
| [notify.example.json](reference/notify.example.json) | — | 通知通道配置示例 |

### plans/ — 任务书与方案

| 文档 | 状态 |
|---|---|
| [p1-plan.md](plans/p1-plan.md) | 已完成（语音命令） |
| [p2-plan.md](plans/p2-plan.md) | 已完成（语音口述） |
| [p2-prompt.md](plans/p2-prompt.md) | 历史交接提示词 |
| [cleanup-plan.md](plans/cleanup-plan.md) | 已完成（0.2.0 清理） |
| [desktop-cross-platform.md](plans/desktop-cross-platform.md) | 进行中（Linux / Windows） |
| [settings-center.md](plans/settings-center.md) | 已实现（设置中心） |

### research/ — 预研

各家 Agent 的接入可行性、hooks 能力、桌面壳选型、业界规范调研。结论已提炼进 [reference/agent-adaptation-matrix.md](reference/agent-adaptation-matrix.md)，这里保留证据与过程。

### private/ 与 raw/

不提交到仓库的内部资料（许可证风险、安全问题、原始凭据）。需要时本地查看。

## 约定

1. **每篇开头有状态行**：生效 / 设计 / 已完成 / 预研，避免把方案当现状读；
2. **生成物不手改**：`reference/capabilities.md` 由 `npm run docs:capabilities` 生成，`npm run check` 会校验；
3. **ADR 只增不改**：结论变了就新写一篇，并在旧文标注被谁取代；
4. **移动文档要更新引用**：仓库里没有自动链接检查，改完用 `grep` 搜旧路径；
5. **图放 `assets/`**，文档里用相对路径引用。