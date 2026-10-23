# mo CLI（P0）

个人工作台的最小执行闭环：**建卡 → 确认 → 派单 → 回执 → 归账**。

设计见 [docs/spec/workbench-flow.md](../docs/spec/workbench-flow.md)，架构见 [docs/architecture.md](../docs/architecture.md)。

## 安装

只需要 Node 18+，没有任何第三方依赖。

**方式一：安装脚本（推荐）**

```bash
bash cli/install.sh              # 软链到 ~/.local/bin（无权限则 /usr/local/bin）
bash cli/install.sh --uninstall  # 卸载
MO_BIN_DIR=/opt/bin bash cli/install.sh   # 指定目录
```

脚本只做一件事：把 `cli/mo.mjs` 软链成 PATH 里的 `mo`，然后跑一次 `mo doctor`。

**方式二：npm link**

```bash
npm link            # 全局命令 mo
npm unlink -g mo-agent
```

**方式三：不安装，用别名**

```bash
alias mo='node /绝对路径/mo-agent/cli/mo.mjs'
```

**先看效果（不花钱、不调模型）**

```bash
bash cli/demo.sh
```

在临时目录里跑完 建卡 → 确认 → 派单 → done → 账本，用假执行者。

## 第一次使用

```bash
mo doctor                 # 自检：node / home / 项目
cd ~/c/work/your-project
mo project add .          # 认领项目，写 .mo-agent/project.json
```

然后建第一张卡。`--exec` 是执行者命令，**它从 stdin 读任务卡**：

| 执行者 | `--exec` 写法 |
|---|---|
| Claude Code | `claude -p "$(cat)"` |
| Codex | `codex exec -` |
| 自己的脚本 | `node scripts/run-task.mjs` |
| 先演示 | `node executor.mjs`（见 `cli/demo.sh`） |

```bash
mo task create \
  --title "给面板加筛选" \
  --deliverable "app/web/tasks.html 有筛选栏" \
  --verify "run:npm test -- --filter tasks" \
  --verify "human:视觉确认" \
  --exec 'claude -p "$(cat)"'
```

```bash
mo task confirm <id>      # 人确认
mo task dispatch <id>     # 派单，等回执
```

注意：Claude / Codex 默认可能需要确认文件写入权限，按各家方式开启（例如 Claude 的 `--permission-mode`）。**权限由你决定，mo 不替你放行。**

## 命令

```bash
# 项目
mo project add [路径] [--name 名称]
mo project list

# 任务
mo task create --title "给面板加筛选" \
  --deliverable "app/web/tasks.html 有筛选栏" \
  --verify "run:npm test -- --filter tasks" \
  --verify "human:视觉确认" \
  --boundary "不要改后端接口" \
  --exec "claude -p" \
  --timeout 45m
mo task confirm <id>
mo task dispatch <id> [--exec 命令] [--timeout 45m]
mo task status <id>
mo task list
mo task cancel <id>

# 其它
mo run <id> [--exec 命令]          # 与 dispatch 等价，用于重跑
mo receipt submit <id> --file -    # 从 stdin 提交回执
mo ledger query [--project 项目] [--task id] [--type task.] [--days 30] [--limit 50]
mo doctor
```

全局选项：`--project <名称|路径>`、`--json`、`--help`。

## 执行者协议

派单时会把**任务卡全文**通过 stdin 交给执行者，并注入环境变量：

| 变量 | 含义 |
|---|---|
| `MO_TASK_ID` | 任务 id |
| `MO_PROJECT` | 项目 id |
| `MO_PROJECT_ROOT` | 项目根目录（也是子进程 cwd） |
| `MO_RECEIPT` | 回执要写入的绝对路径 |

执行者只需做一件事：**把回执写到 `MO_RECEIPT`**。

```json
{
  "taskId": "t_01HXYZ",
  "status": "done",
  "summary": "一句话结论",
  "artifacts": [{ "path": "app/web/tasks.html", "kind": "file" }],
  "verify": [{ "cmd": "npm test -- --filter tasks", "exit": 0 }],
  "deviations": [],
  "pitfalls": [],
  "needs": []
}
```

规则：

- `status=done` 时 `verify` 不能为空，且不能有 `exit != 0` 的项；
- 没写回执 → `blocked(missing_receipt)`，**不当作成功**；
- 回执非法 / taskId 不匹配 → `blocked(bad_receipt)`。

## 写一份回执（手动）

```bash
cat <<'JSON' | mo receipt submit t_01HXYZ --file -
{ "taskId": "t_01HXYZ", "status": "done", "summary": "改完了", "verify": [{ "cmd": "npm test", "exit": 0 }] }
JSON
```

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（`dispatch` 只有在任务进入 `done` 时才返回 0） |
| 1 | 业务失败：状态不对、回执缺失/非法、执行异常 |
| 2 | 用法错误（`E_USAGE`） |

错误以 `[E_CODE] 消息` 输出到 stderr，码表见 spec §8。

## 文件位置

| 内容 | 位置 |
|---|---|
| 项目身份 | `<repo>/.mo-agent/project.json`（要提交） |
| 任务卡 | `<repo>/.mo-agent/tasks/<taskId>.md`（要提交） |
| 回执 | `<repo>/.mo-agent/receipts/<taskId>.json`（默认 ignore） |
| 项目登记表 | `~/.mo-agent/projects.json` |
| 账本 | `~/.mo-agent/ledger/YYYY-MM.jsonl` |

`MO_AGENT_HOME` 可覆盖 `~/.mo-agent`，测试与多套环境都用它隔离。

## P0 边界

已实现：项目认领、状态机、卡/回执校验、派单执行、账本、CLI。

未实现（按 spec 属于 P1–P3）：MCP 端点、守护进程、`verify` 自动执行、watchdog/重试、记忆检索与注入、面板 UI。

因此：`verified` 目前一律是 `unverified`——回执里的自检**没有被 core 复跑**，这是 P2 的事。