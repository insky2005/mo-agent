# mo CLI 使用说明

`mo` 是一个命令行工具：把讨论落成**任务卡**，派给执行者（Claude / Codex / 任意命令），
收回**回执**，由 core 亲自跑**验收**，并把全过程记进**账本**。

这份文档是自包含的：安装、概念、命令、排障都在这里，不需要再看别的文档。

## 1. 安装

### 1.1 一条命令（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/scripts/install-remote.sh | bash
```

它会从 GitHub Releases 下载对应平台的单文件二进制，装到 `~/.local/bin/mo`（可用 `MO_BIN_DIR` 改）。
需要同时给 Agent 装技能时：

```bash
curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/scripts/install-remote.sh | bash -s -- --with-skill
```

### 1.2 从源码

```bash
bash scripts/install-cli.sh                  # 构建/复用 cli/dist/mo，装到 ~/.local/bin
bash scripts/install-cli.sh --with-skill     # 顺带装 Agent 技能
bash scripts/install-cli.sh --no-completion  # 不写 shell 补全
bash scripts/install-cli.sh --uninstall      # 卸载
```

### 1.3 装完要做的两件事

**PATH**：如果 `~/.local/bin` 不在 PATH 里，加进 shell 配置（`~/.zshrc` 或 `~/.bashrc`）：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**补全**（可选）：安装脚本会写进 rc，新终端自动加载；当前终端想立刻用：

```bash
hash -r; eval "$(mo completion zsh)"     # bash 用 mo completion bash
```

### 1.4 验证

```bash
mo --version
mo doctor
```

### 1.5 另一条路：从技能开始，全程由 Agent 装

前面两条都是"先装 mo，再装技能"。也可以反过来：**只把技能放进去，剩下的交给 Agent**。

1. 先装技能（二选一）：
   - `npx skills add insky2005/mo-agent`
   - 或把 `skills/mo/SKILL.md` 放到 `~/.agents/skills/mo/SKILL.md`（或对应 Agent 的技能目录）

2. 开一个新的 Agent 会话，两种入口都行：

   **主动安装**——直接让 Agent 装：

   - `/mo 安装`（客户端支持技能斜杠时）
   - 或直接说「帮我装一下 mo」

   Agent 会检查 `mo --version`，说明安装会下载二进制、写 `~/.local/bin`，征得你同意后执行。

   **被动安装**——先派活，缺了再装：

   - `/mo 把这件事落成任务卡`，或说「用 mo 把这件事落成任务卡」

   Agent 在动手前会先检查环境，发现 `mo` 不在，就停下来提议安装；你同意后它装完**接着做原任务**，不需要你重新说一遍。

3. 装完后：
   - 当前会话用 `~/.local/bin/mo` 绝对路径继续；
   - 新开终端后 `mo` 才在 PATH 里。

适合：机器上已经有 Claude / Codex，想少敲命令。

注意：
- Agent 需要 shell 权限与网络；
- 安装会写 `~/.local/bin`、可能改 shell 配置，所以它必须先问你；
- 这条路不会自动配补全（远端安装器不写 rc），需要时自己执行 `mo completion`。

## 2. 核心概念

| 概念 | 是什么 | 存在哪 |
|---|---|---|
| 项目 | 一个仓库，有固定 id（`p_…`） | `<repo>/.mo-agent/project.json`（要提交） |
| 任务卡 | 一次任务的说明：交付物、验收、边界、执行者 | `<repo>/.mo-agent/tasks/<id>.md`（要提交） |
| 执行者 | 真正干活的命令（`claude -p …` / 你的脚本） | 内置模板或个人/项目配置 |
| 回执 | 执行者交回来的 JSON：做了什么、验收结果 | `<repo>/.mo-agent/receipts/<id>.json` |
| 验收 | 卡上写的检查项，由 core 执行，不是执行者说了算 | 卡里的 `verify:` |
| 账本 | 只追加的事件流 | `~/.mo-agent/ledger/YYYY-MM.jsonl` |
| 日志 | 每次派单的完整输出 | `<repo>/.mo-agent/logs/<id>.log` |

## 3. 五分钟上手

```bash
cd 你的项目
mo project init .                 # 生成 .mo-agent/ 与 AGENTS.md 说明

mo worker list                    # 看有哪些执行者、本机装了没

mo task create \
  --title hello \
  --deliverable "print hello world" \
  --verify "run:echo hello world" \
  --worker claude                 # 或 --exec "任意命令"

mo task confirm t_01H…            # 人确认，确认前不能派单
mo task dispatch t_01H…           # 跑执行者 → 收回执 → 自动验收

mo task status t_01H…             # 状态、验收、最近事件
mo ledger query --task t_01H…     # 完整时间线
mo task logs t_01H…               # 执行者完整日志
```

## 4. 命令速查

| 命令 | 作用 |
|---|---|
| `mo project init [路径]` | 初始化项目（`.mo-agent/` + `AGENTS.md`） |
| `mo project agent [--remove]` | 只写/删 Agent 说明文件 |
| `mo project list` | 已登记项目 |
| `mo task create …` | 建卡（draft） |
| `mo task confirm <id>` | 发起确认请求（不改状态） |
| `mo task approve \| reject <id>` | 人批准 / 拒绝（需 TTY） |
| `mo task requests` | 待批准的请求 |
| `mo task dispatch <id>` | 派单并等待，含自动验收 |
| `mo task verify <id>` | 对已 done 的卡重跑验收 |
| `mo task logs <id> [--tail N]` | 执行者日志 |
| `mo task status <id>` | 状态与最近事件 |
| `mo task list` | 本项目任务 |
| `mo task cancel <id>` | 取消 |
| `mo receipt submit <id> --file -` | 手工写回执（不改状态） |
| `mo receipt apply <id>` | 应用已有回执：验收 + 改状态 |
| `mo ledger query [--task id]` | 查账本 |
| `mo worker list \| add \| remove` | 查看/注册执行者 |
| `mo skill list \| install \| uninstall` | 给 Agent 装 mo 技能 |
| `mo memory recall "关键词"` | 召回知识条目（派单时自动注入同一批） |
| `mo memory list \| init \| path` | 列出 / 建骨架 / 打印记忆库位置 |
| `mo memory migrate` | 把旧的 `knowledge/` 搬到 `memory/` |
| `mo memory candidates` | 待裁决的候选条目 |
| `mo memory accept \| reject <id>` | 采纳 / 丢弃候选（冲突时拒绝写入） |
| `mo inbox pull [--peek]` | 拉取任务通知（done / blocked / failed），拉完归档 |
| `mo mcp` | stdio MCP 服务（给主 Agent 接） |
| `mo agent describe \| add` | 输出契约 / 合并 MCP 配置 |
| `mo doctor` | 自检 |
| `mo help` | 帮助 |

## 5. 任务生命周期

```
draft ──approve──▶ confirmed ──dispatch──▶ running ──┬─▶ done
                                                       ├─▶ failed
                                                       ├─▶ blocked ──dispatch──▶ running
                                                       └─▶ canceled / expired
```

| 状态 | 意思 | 下一步 |
|---|---|---|
| `draft` | 刚建，等人拍板 | 先 `mo task confirm` 发请求，再由人 `mo task approve` |
| `confirmed` | 可以派了 | `mo task dispatch` |
| `running` | 执行者在跑 | 等 |
| `done` | 回执合法 + 验收通过 | 验收没过会变 `blocked` |
| `blocked` | 缺回执 / 验收失败 / 需人工 | 重试、补回执或取消 |
| `failed` | 执行者崩溃 | 看日志后重来 |

## 6. 验收

建卡时用 `--verify` 写检查项，四种形式：

| 写法 | 判定 |
|---|---|
| `run:<命令>` | 在项目根执行，退出码 0 通过；默认 60s 超时（`MO_VERIFY_TIMEOUT_MS` 可调） |
| `check:<路径> 存在` | 文件存在通过 |
| `check:<路径> 包含 <文本>` | 文件内容包含文本通过 |
| `human:<说明>` | 不执行，等人确认 |

派单时由 **core** 执行（不是执行者自己说通过就算）。失败时任务变 `blocked`，原因 `verify_failed`；
只有 `human:` 项时变 `blocked`，原因 `needs_human`。没有验收标准的卡会警告 `W_NO_VERIFY`。

## 7. 回执与补救

正常流程：执行者把 JSON 写到 `$MO_RECEIPT`（路径由 mo 通过环境变量给出），dispatch 自动读取。
回执至少要有 `taskId`、`status`、`summary`；`status=done` 还要求 `verify` 非空。

手动补交：

```bash
cat <<JSON | mo receipt submit t_01H… --file -
{ "taskId": "t_01H…", "status": "done", "summary": "改完了",
  "verify": [{ "cmd": "npm test", "exit": 0 }] }
JSON

mo receipt apply t_01H…    # 生效：跑验收并更新状态
```

`submit` 只写文件，`apply` 才改状态——两者分开，便于先校验再应用。
`submit` 加 `--dry-run` 可以只校验不写。

## 8. 查看详细日志（调试与优化）

### 8.1 实时看

执行者的 stdout/stderr 会**边跑边打到终端**（走 stderr，不污染 `--json`）：

```bash
mo task dispatch t_01H… 2>exec.log
mo task dispatch t_01H… 2>&1 | tee exec.log
```

### 8.2 事后看

每次派单都会落一份日志：

```bash
mo task logs t_01H…             # 全部
mo task logs t_01H… --tail 30   # 最后 30 行
```

日志头部有定位问题需要的事实：

```
command:  pi -p "$(cat)"
cwd:      /path/to/project
timeout:  2700000ms
exit:     0
duration: 10547ms
---
（执行者的完整输出）
```

### 8.3 为什么看不到执行者“中间做了什么”

mo 只能看到执行者进程的 stdout/stderr。很多 Agent 的非交互模式**只打印最终答复**，
中间的读文件、跑命令不会输出。要看过程，用执行者自己的详细模式：

```bash
# Claude：流式 JSON，含每次工具调用
mo task dispatch <id> --exec 'claude -p "$(cat)" --output-format stream-json --verbose --permission-mode acceptEdits'

# 其他 Agent：看它们各自的 --verbose / 日志目录
```

Agent 自己的会话记录也在它们各自的目录里（如 `~/.claude/projects/`、`~/.codex/sessions/`）。

### 8.4 账本是最终事实

```bash
mo ledger query --task t_01H…
```

每条事件带 `actor`：`agent`（mo task 发起）、`human`（确认）、`core`（内核判定）、`worker`（回执）。

## 9. 执行者

### 9.1 内置模板

| 名称 | 命令 |
|---|---|
| `claude` | `claude -p "$(cat)" --permission-mode acceptEdits` |
| `codex` | `codex exec -s workspace-write -` |
| `qodercli` | `qodercli -p "$(cat)" --permission-mode accept_edits` |
| `qoderclicn` | `qoderclicn -p "$(cat)" --permission-mode accept_edits` |
| `pi` | `pi -p "$(cat)"` |
| `qwen` | `qwen --approval-mode auto-edit "$(cat)"` |

`mo worker list` 会显示每个模板的来源、是否可用（命令与 `requires` 都要存在）。
命令不存在的模板选不了；`mo task create --worker` 会警告，`dispatch` 会直接报错。

### 9.2 自定义

```bash
mo worker list                                  # 内置 + 自定义
mo worker add fast --command 'claude -p "$(cat)" --model sonnet'
mo worker add local --command "node scripts/exec.mjs" --requires node
mo worker add team --command "…" --project       # 写进项目配置，跟着仓库走
mo worker remove fast
```

优先级：内置 < 个人（`~/.mo-agent/workers.json`）< 项目（`<repo>/.mo-agent/workers.json`）。
`--requires` 声明命令里看不出来的依赖（比如 `node` 包装脚本内部调用 claude）。

### 9.3 用完整命令

不想注册模板时，`--exec` 直接给命令：

```bash
mo task create … --exec "node scripts/run.mjs"
mo task dispatch <id> --exec "claude -p \"$(cat)\" --model sonnet"
```

`--worker` 与 `--exec` 互斥。

## 10. 接入 Agent（技能）

技能让主 Agent 知道什么时候该用 mo。安装：

```bash
mo skill install        # 交互选择装到哪些 Agent
mo skill list           # 看装了没
mo skill uninstall      # 卸载
```

可装位置：`~/.agents/skills`（通用）、`~/.pi/agent/skills`、`~/.claude/skills`、`~/.codex/skills`、
`~/.qoder/skills`、`~/.qoder-cn/skills`、`~/.qwen/skills`。

也可以用 skills 生态的安装器：

```bash
npx skills add insky2005/mo-agent
```

装完新开一个 Agent 会话才会加载。

### 10.1 用 MCP（stdio）

支持 stdio MCP 的客户端（Claude Code、DSH 等）可以直接把 `mo` 当 MCP 服务挂上：

```json
{
  "mcpServers": {
    "mo": { "command": "/path/to/mo", "args": ["mcp"] }
  }
}
```

挂上之后，主 Agent 能用的工具是：`task_create`、`task_confirm`、`task_dispatch`、`task_status`、`inbox_pull`、`ledger_query`、`memory_recall`、`memory_propose`。

不想手写配置也可以：

```bash
mo agent add --mcp ./mcp.json    # 合并进任意 mcpServers 配置，幂等 + 备份
mo agent add --prompt            # 只能读文字的 Agent，直接粘这段
mo agent describe --json          # 让 Agent 自己读能力清单
mo skill install                  # 装技能（技能内容由 contract 生成）
mo agent describe --json          # 机器可读的能力清单

项目里的 `AGENTS.md` / `.mo-agent/MO.md` 不从这里出——那是 `mo project init` 的产物；`describe` 只给"能直接贴给 Agent"的两种。
```

**故意没有** `task_approve` / `task_reject`（批准得你来）和 `memory_accept`（记忆入库得你拍板）。`task_confirm` 只发请求，不改变卡片状态。每个工具调用是一次 `mo … --json` 子进程，所以 `task_dispatch` 会一直阻塞到执行者跑完。

## 11. 知识与收件箱

**知识库**：纯 markdown，一个 `## 标题` 一个条目；派单时按任务卡内容召回，命中条目的正文直接嵌进执行者拿到的信封，执行者不用再去翻文件。

```markdown
## 派单超时不要直接重试

- trigger: 派单, 超时, retry
- tags: 任务

先看 mo task logs，确认是执行者卡住还是回执没写。
```

| 位置 | 作用 |
|---|---|
| `~/.mo-agent/memory/preferences.md` | 我的偏好 |
| `~/.mo-agent/memory/pitfalls/*.md` | 避坑 |
| `~/.mo-agent/memory/decisions/*.md` | 已定的决策 |

`mo memory init` 建骨架（幂等，不覆盖），之后拿编辑器改就行。`_` 开头的文件不参与召回；没有索引和缓存，改完下一次派单就生效。

**候选区**：执行者回执里带的 `pitfalls`，或主 Agent 觉得该记下的偏好，都先落进 `memory/candidates/`，等人裁决，不会自动写进知识库：

```bash
mo memory propose --title "派单超时先看日志" --trigger 派单 --trigger 超时 --body "先看 logs"
mo memory candidates            # 看待裁决的（冲突的会标出来）
mo memory accept <id>           # 采纳，写进知识库
mo memory reject <id>           # 丢弃
```

- 缺触发条件直接拒收（`E_MEMORY_INVALID`）；
- 同名或正文高度重合判冲突，`accept` 不给写（`E_MEMORY_CONFLICT`），只给新旧对比：改/删旧条目再采纳，或直接丢弃。

**收件箱**：任务进入 `done` / `blocked` / `failed` 时，core 会落一条通知。主 Agent 拿不到推送时，用 `mo inbox pull` 主动拉——条目在 `~/.mo-agent/inbox/pending/`，拉完移到 `pulled/`，所以重复拉不会拿到旧消息。

```bash
mo inbox pull            # 拉取并归档
mo inbox pull --peek     # 只看不归档
mo inbox pull --task t_x # 只拉这一条
```

## 12. 文件位置

| 内容 | 路径 |
|---|---|
| 项目身份证 | `<repo>/.mo-agent/project.json` |
| 任务卡 | `<repo>/.mo-agent/tasks/<id>.md` |
| 回执 | `<repo>/.mo-agent/receipts/<id>.json`（默认 ignore） |
| 执行日志 | `<repo>/.mo-agent/logs/<id>.log`（默认 ignore） |
| 项目登记表 | `~/.mo-agent/projects.json` |
| 自定义执行者 | `~/.mo-agent/workers.json` |
| 账本 | `~/.mo-agent/ledger/YYYY-MM.jsonl` |
| 确认请求 | `~/.mo-agent/approvals/<a_…>.json` |
| 知识库 | `~/.mo-agent/memory/`（`MO_AGENT_MEMORY` 可覆盖） |
| 记忆候选 | `~/.mo-agent/memory/candidates/<id>.json` |
| 收件箱 | `~/.mo-agent/inbox/pending/`、`inbox/pulled/` |

`MO_AGENT_HOME` 可覆盖 `~/.mo-agent`，用于隔离测试环境。

## 13. 退出码与错误

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 任务没完成（blocked / failed）或运行时错误 |
| `2` | 用法错误（`E_USAGE`），参数不对 |

错误以 `[E_CODE] 消息` 输出到 stderr。常见码：

| 码 | 含义 |
|---|---|
| `E_PROJECT_UNBOUND` / `E_PROJECT_NOT_FOUND` | 当前目录不在项目里，或路径不对 |
| `E_NOT_CONFIRMED` | 卡未确认 / 当前状态不能派单 |
| `E_NO_EXECUTOR` | 卡里没有执行者 |
| `E_ASSIGNEE_UNSUPPORTED` | 执行者命令未安装，或与要求不符 |
| `E_NO_RECEIPT` / `E_BAD_RECEIPT` | 回执缺失 / 不合法 |
| `E_NOT_DONE` | 只有 done 的卡能重跑验收 |
| `E_FORBIDDEN` | 批准只能在人的终端里做（或没 TTY） |
| `E_CARD_CHANGED` | 批准前卡片被改，批准作废 |
| `E_CARD_INVALID` / `E_CARD_TOO_LARGE` | 卡不合法 / 超过 8KB |
| `E_TRANSITION` | 状态机不允许这次转换 |

## 14. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `E_PROJECT_UNBOUND` | 先 `mo project init .`，或加 `--project` |
| `W_NO_VERIFY` | 卡没验收标准：补 `--verify "run:…"` |
| `blocked / missing_receipt` | 执行者没写回执：看日志；或 `receipt submit` + `apply` 补交 |
| `blocked / verify_failed` | 验收没通过：看输出，修完 `mo task dispatch` 重试 |
| `blocked / needs_human` | 只有 `human:` 验收项：人确认后 `mo task cancel` 或重派 |
| 补全不生效 | 当前终端没执行 `hash -r; eval "$(mo completion zsh)"` |
| 命令找不到 | `~/.local/bin` 不在 PATH |

## 15. 限制

- 只支持 macOS / Linux；Windows 未验证。
- 派单是同步阻塞的：执行者跑多久，命令就等多久。
- 批准要走 `mo task approve`：要求 TTY，并校验卡片指纹（批准前改卡会导致作废）；`--yes` 是给 CI 的逃生口，会绕过这道防线。
- 手机/桌面批准还没写进同一个决定文件，目前只有终端这一条批准通道。
- 没有 daemon，也没有推送：任务的结束通知落在收件箱，主 Agent 需要主动 `mo inbox pull`，或查 `status` / `ledger`。
- 记忆回流还是"人裁决"：候选不会自动入库，得跑 `mo memory accept`。
