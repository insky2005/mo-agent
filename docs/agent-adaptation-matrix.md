# Agent 适配性矩阵

> 持续更新的总表：记录每个 Agent **能不能接进 mo-agent、靠什么接、接到什么程度**。
> 最后更新：2026-10-21 · 版本 v0.2

本表是「研究态」总表，和运行态表分工如下：

| 文档 | 内容 | 维护方式 |
|---|---|---|
| [capabilities.md](capabilities.md) | 已接入 Agent 的运行态能力 | 由 `npm run docs:capabilities` 从 profile 生成，勿手改 |
| **本文** | 所有候选 Agent 的适配性、证据级别、优先级 | 人工维护；每次预研 / 接入后更新 |

判定口径、状态图例、维护规则见文末。原始证据放在 `docs/research/` 下，本表只放结论。

## 0. 一眼看结论

- **已接入 3 个**：Claude Code、DeepSeek Harness、Qoder CN。
- **WorkBuddy 代码已落地**：profile + genie transcript 适配器 + hook 一键配置 + 11 个测试；还差一次真机 hook 验证。
- **同源低价**：Gemini CLI / Qwen Code（同一套 hook 语义），Cursor（放行型 hook，IDE 用户多）。
- **只能走 ACP**：Codex、Kimi（hook 审批路径目前是坏的）。ACP 只能控制「我们自己启动的会话」，补不了旁路观测。
- **明确不做**：Aider、Windsurf / Kiro、通义灵码 / Comate / 文心快码这类没有外部决策点的产品。
- **一个易混点**：国产模型 + Claude Code / Codex 壳，不算新 Agent，按壳评估即可（见 [domestic-agents-hooks.md](research/domestic-agents-hooks.md)）。

## 1. 总表

图例：✅ 支持 / 🟡 部分支持或待验证 / 🟠 待实测或受限 / ⚠️ 有已知问题 / ❌ 不支持 / ⛔ 不可行 / — 不适用。

| Agent | 形态 | 观测源 | runEnd | Hook 决策点 | Hook 放行 | ACP | 对现有会话的控制 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|---|---|
| **Claude Code** | CLI | `~/.claude/projects/*/*.jsonl` | explicit | `PermissionRequest` | ✅ | ✅ | — | ✅ 已接入 | L2 |
| **DeepSeek Harness** | 桌面 / CLI | 原生 API | inferred | 原生事件 | ✅ | — | prompt / cancel | ✅ 已接入 | L2 |
| **Qoder CN** | 桌面 + IDE | `~/.qoder-cn/projects/*/*.jsonl` | explicit | `PermissionRequest` / `Notification` / `Stop` | ✅ | ✅ | — | ✅ 已接入 | L2 观测 / L1 放行 |
| **WorkBuddy** | 桌面 | `~/.workbuddy/projects/*/*.jsonl`（genie） | inferred | `PermissionRequest` / `Notification` | ✅ | ✅ | — | 🟡 已实现，待真机验证 | L2 观测（测试）/ L1 放行 |
| **CodeBuddy CLI** | CLI | 待确认 | 待确认 | `PreToolUse` / `PermissionRequest` | ✅ 预计 | ✅ | — | 🟠 待实测 | L1 |
| **Cursor** | IDE / CLI | 待确认 | 待确认 | `beforeShellExecution` / `preToolUse` 等 | ✅ | ✅ | — | 🟠 待本机验证 | L0 |
| **Gemini CLI** | CLI | `~/.gemini`（格式待确认） | 待确认 | `BeforeTool`（`decision`） | ✅ | ✅ | — | 🟠 待本机验证 | L0 |
| **Qwen Code** | CLI | 待确认 | 待确认 | hooks（与 Gemini 同源） | ✅ | ✅ | — | 🟠 待本机验证 | L0 |
| **GitHub Copilot CLI** | CLI | 待确认 | 待确认 | `preToolUse` | ⚠️ 已知 allow 仍弹框 | ✅ | — | 🟠 暂缓（等上游修） | L0 |
| **Codex CLI** | CLI | `~/.codex/sessions/**/*.jsonl` | 待确认 | hooks 仅 block | ❌ | ✅ | — | 🟠 仅 ACP 路线 | L0 / L1 |
| **iFlow CLI** | CLI | 待确认 | 待确认 | hooks | 待确认 | ✅（实验） | — | 🟠 待实测 | L0 |
| **Trae** | IDE / CLI | 待确认 | 待确认 | HTTP hooks（企业版） | 待确认 | ✅ | — | 🟠 企业版限定 | L0 |
| **Kimi CLI** | CLI | 待确认 | 待确认 | hooks（Beta，审批不触发） | ❌ | ✅ | — | 🟠 仅 ACP 可试 | L0 |
| **OpenCode** | CLI | 待确认 | 待确认 | `permission.ask` 插件 | ⚠️ 接入不全 | ✅ | — | 🟠 待观察 | L0 |
| **Cline** | IDE 插件 / SDK | 待确认 | 待确认 | SDK 编程式审批 | 🟡 托管型 | 待确认 | 托管可 | 🟠 非旁路 | L0 |
| **Goose** | CLI / 桌面 | 待确认 | 待确认 | gotohuman-mcp 扩展 | 🟡 托管型 | 待确认 | 托管可 | 🟠 非旁路 | L0 |
| **Aider** | CLI | — | — | 终端 y/n，无拦截点 | ❌ | — | — | ⛔ 不可行 | L0 |
| **Windsurf / Kiro** | IDE | — | — | IDE 内部，无外部决策点 | ❌ | — | — | ⛔ 不可行 | L0 |
| **通义灵码 / Comate / 文心快码** | IDE 插件 | — | — | 无外部决策点 | ❌ | — | — | ⛔ 不可行 | L0 |

说明：

- 表中「放行」指**旁路 hook** 能否代替用户在本地弹框上点允许；「ACP」是另一条路线，只能控制 mo-agent 自己启动的会话，不能接管用户已经跑起来的进程。
- `runEnd` 的 explicit / inferred 定义见 [core/contract.mjs](../core/contract.mjs) 与 [event-contract.md](spec/event-contract.md)。
- 状态为 ✅ 的行必须以 `adapters/profiles/*.json` 为准；本表不重复 profile 的细节。

## 2. 同族多形态：别把「一个产品」当成「一个 Agent」

同一个厂商往往有多个入口，hook 是否加载、transcript 在哪都不一样。已实测的差异：

| 产品 / 形态 | 观测 | 用户级 hook | 远程放行 | 结论 |
|---|---|---|---|---|
| Claude Code CLI | ✅ 标准 transcript | ✅ 读 `~/.claude/settings.json` | ✅ | 已接入 |
| Claude Desktop · Code 面 | ✅ transcript | ✅ 理论生效 | 🟡 待实测 | 可接，需验证桌面授权框是否让位 |
| Claude Desktop · Cowork 面 | ✅ 会话内 transcript | ❌ 每会话独立 `CLAUDE_CONFIG_DIR` | ❌ | ⛔ 当前不可行 |
| Qoder CN 桌面 / IDE | ✅ transcript | ✅ `~/.qoder-cn/settings.json` | ✅ | 已接入 |
| Qoder CLI | ✅ transcript | ✅ | ✅ | 可选，走 ACP 更省事 |
| WorkBuddy 桌面 | ✅ genie transcript | ✅ `~/.workbuddy/settings.json` | ✅ | 🟡 已实现，待真机验证 |
| WorkBuddy 企微助理 | 云端通道 | — | ✅ 原生「确认操作」 | 原生能力，可共存但要去重 |
| CodeBuddy CLI | 待确认 | ✅ 预计 `~/.codebuddy/settings.json` | ✅ 预计 | 🟠 与 WorkBuddy 同源，待实测 |

结论：**profile 要按「产品形态」拆，不要按厂商拆。** 典型反例是 Claude Desktop 的 Code / Cowork 两面、WorkBuddy 桌面 / 企微助理。

## 3. 优先级

粗估只含「能到可用」的工程成本，不含联调和版本漂移。

| 优先级 | Agent | 理由 | 粗估 |
|---|---|---|---|
| **P0** | WorkBuddy 桌面 | 已实现：profile + genie 解析器 + hook 一键配置 + 测试 | 已完成（待真机验证） |
| **P1** | Gemini CLI | 放行型 hook，profile 已声明；观测格式待补 | 0.5–1 人日 |
| **P1** | Qwen Code | 与 Gemini 同源，适配几乎免费 | 0.5–1 人日 |
| **P1** | Cursor | 放行型 hook，IDE 用户基数大；观测面待确认 | 1–2 人日起 |
| **P2** | CodeBuddy CLI | 与 WorkBuddy 同源，可能复用大部分代码 | 0.5 人日（验证后） |
| **P2** | Codex CLI | hook 只能拦；要走 ACP 托管路线，架构成本高 | 2–3 人日 |
| **P2** | iFlow / Trae | 文档存在，放行能力待实测；Trae 还有企业版门槛 | 待实测后估 |
| **暂缓** | Kimi CLI / Copilot CLI | 上游审批链路有问题，等修复 | — |
| **不做** | Aider / Windsurf / Kiro / IDE 插件 | 没有外部决策点，旁路方案不成立 | — |

产品层提醒：WorkBuddy 自己已经支持企微远程批准（手机下发任务 + 确认操作）。
如果目标用户已经在用企微助理，WorkBuddy 的适配价值主要是「统一面板 / 跨 Agent 通知」，
而不是「唯一能远程批准 WorkBuddy 的方案」。详见 [workbuddy-desktop.md](research/workbuddy-desktop.md)。

## 4. 维护规则（持续更新）

### 4.1 什么时候更新

- 新做一个 Agent 的预研 → 新增一行；
- 某个 Agent 从「待实测」变成「已接入」→ 改状态、补证据级别、链接 profile；
- 上游修复 / 版本升级导致能力变化 → 改状态，并在变更记录里写清「降级/升级」；
- 发现之前的结论有误 → 直接改，但保留变更记录。

### 4.2 怎么加一行（5 步）

1. **定证据级别**：先看官方文档，再看本机安装，最后做端到端实测；
2. **填总表**：观测源、runEnd、hook 决策点、放行、ACP、控制、状态、证据；
3. **写预研**：细节放 `docs/research/<agent>-*.md`，本表只链接结论；
4. **接入时**：加 `adapters/profiles/<id>.json` + adapter + fixture，跑 `npm test`；
5. **同步运行态**：`npm run docs:capabilities`，并更新本文变更记录与日期。

### 4.3 状态与证据级别

状态：

| 状态 | 含义 |
|---|---|
| ✅ 已接入 | profile + adapter + 测试已落地；至少一条 L2 观测证据（放行可 L1） |
| 🟡 可接入待实现 | 机制已验证（≥ L1），只差代码 |
| 🟠 待实测 / 受限 | 只有文档或本机检查，存在未确认项或版本/套餐限制 |
| ⛔ 不可行 | 没有外部决策点，或已知上游链路损坏且无替代 |
| ❔ 未评估 | 还没看过，不要猜 |

证据级别：

| 级别 | 含义 |
|---|---|
| L0 | 官方文档、公开 issue |
| L1 | 本机安装包 / 配置 / 日志 / 代码检查 |
| L2 | 本机端到端实测（含一次真实的手机放行） |
| L3 | 多版本 / 多机验证 |

规则：**✅ 必须有 L2 观测证据（放行能力可以单独标 L1）；🟡 至少 L1；🟠 可以是 L0。** 不要把 L0 写成 🟡。

### 4.4 和运行态表的关系

- 本文的「已接入」行如果和 [capabilities.md](capabilities.md) 不一致，以 `adapters/profiles/*.json` 为准；
- 不要把本文当配置源：真正的 profile 才是事实源；
- 本文可以比运行态表「超前」，但超前的行必须标 🟡/🟠 和证据级别。

## 5. 待验证清单

这些是「下一轮预研/实测」的入口，完成后回来改总表和状态：

| 项 | 当前 | 验证动作 | 完成后 |
|---|---|---|---|
| WorkBuddy hooks | 已实现，L1 | 加 `SessionStart` 写文件 + `PermissionRequest` 返回 allow，各跑一次 | 升 L2 → 整行 ✅ |
| WorkBuddy runEnd | inferred | 跑一个 5+ 工具调用的多步任务，看中间是否写 assistant `message` | 定 explicit / inferred |
| Gemini CLI | L0 文档 | 本机装 CLI，验证 `BeforeTool` allow + transcript 格式 | 升 L1/L2 |
| Qwen Code | L0 文档 | 同上（与 Gemini 同源，可一起验） | 升 L1/L2 |
| Cursor | L0 文档 | 本机验证 IDE hook 能否 allow + 会话观测面 | 升 L1 |
| CodeBuddy CLI | L1 代码 | 确认配置目录、transcript 格式、hook 是否同 WorkBuddy | 决定是否复用解析器 |
| Copilot CLI | L0 + 已知 bug | 跟踪 issue #2643 | 修复后重评 |
| Kimi CLI | L0 + 已知 bug | 跟踪 #2337 / #2048；或只走 ACP | 修复后重评 |
| iFlow / Trae | L0 文档 | 实测 hook 放行；Trae 确认套餐门槛 | 定 🟡 / 🟠 |

## 6. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-10-21 | 初版：汇总 Claude Code / DSH / Qoder CN / WorkBuddy，以及 Cursor、Gemini、Qwen、Copilot、Codex、iFlow、Trae、Kimi、OpenCode、Cline、Goose、Aider、Windsurf/Kiro、IDE 插件 |
| v0.2 | 2026-10-21 | WorkBuddy 适配落地：profile、genie transcript 解析、hook 一键配置、测试；状态改为「已实现，待真机验证」。顺带修复 hook-cli 放行路径的 `result` 作用域与 stdout 刷新问题 |

## 7. 参考

### 项目内

- [远程批准能力预研](research/remote-approval-hooks.md)
- [国产 Agent hooks 盘点](research/domestic-agents-hooks.md)
- [Qoder CN 桌面端预研](research/qoder-cn-desktop.md)
- [Claude Desktop 预研](research/claude-desktop.md)
- [WorkBuddy 桌面端预研](research/workbuddy-desktop.md)
- [运行态能力表](capabilities.md)

### 外部

- Claude Code hooks：<https://code.claude.com/docs/en/hooks>
- Cursor hooks：<https://cursor.com/docs/hooks>
- Gemini CLI hooks：<https://geminicli.com/docs/hooks/reference/>
- Qwen Code hooks：<https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/>
- Copilot hooks：<https://docs.github.com/en/copilot/reference/hooks-reference>
- Copilot allow 仍弹框 issue：<https://github.com/github/copilot-cli/issues/2643>
- Codex / ACP：<https://agentclientprotocol.com>
- Kimi 审批不触发 hook issue：<https://github.com/MoonshotAI/kimi-cli/issues/2337>
- iFlow hooks：<http://docs.iflow.cn/cli/examples/hooks/>
- Trae 企业 Hook：<https://docs.trae.cn/enterprise_automate-actions-with-hooks>
- WorkBuddy Hooks：<https://www.workbuddy.ai/docs/cli/hooks>
- WorkBuddy 企微助理：<https://www.workbuddy.cn/docs/workbuddy/Wecom-Guide>
- Qoder CLI hooks：<https://docs.qoder.com/cli/hooks-reference>
