# 开发提示词：mo config 与 mo setup

> 用途：新开一个会话时，把下面「任务正文」整段贴给 Agent。
> 分支：`feat/workbench-p0`　范围：全局配置 + 首次装配（不含面板与 daemon）。

---

## 任务正文

# 任务：实现 `mo config` 与 `mo setup`（全局配置 + 首次装配）

## 背景

仓库 `/Users/dev/c/work.ai/deepseek-harness/mo-agent`，分支 `feat/workbench-p0`。

mo 是一个 CLI + 本地 daemon 的任务派发工具：人建卡、批准，派给无头或会话型 worker，收回执、跑验收、记账。核心闭环已完成，现有 479 项测试全绿。

现在缺两块全局配置能力：

1. **没有任何全局配置文件**——`host/config.mjs` 只认命令行参数和环境变量；
2. **没有首次装配命令**——用户装完 CLI 后要自己跑 `mo project init`、`mo skill install`、`mo agent add --mcp`、`mo memory init`、`mo worker use`、`mo terminal use`，六件事分散。

目标：加 `~/.mo-agent/config.json` 与两个命令 `mo config`、`mo setup`。

## 现状（先读这些）

| 文件 | 作用 |
|---|---|
| `cli/mo.mjs` | 路由表 `ROUTES`，新增命令要在这里注册 |
| `cli/lib/help.mjs` | `GROUPS` 帮助分组；新命令必须加组，否则 `mo help` 看不到 |
| `cli/lib/complete.mjs` | 补全 `SPEC` 与 `TOP_LEVEL`；`cli/complete.test.mjs` 会断言 TOP_LEVEL 全集 |
| `cli/lib/paths.mjs` | `moHome()`（受 `MO_AGENT_HOME` 影响）、`projectDir()` |
| `cli/lib/fsx.mjs` | `readJsonSafe` / `writeJsonAtomic`，写文件一律用它 |
| `cli/lib/output.mjs` | `emit(options, jsonPayload, humanFn)` 与 `table(rows, headers)` |
| `cli/lib/workers-config.mjs` | `~/.mo-agent/workers.json`，含 `default` |
| `cli/lib/terminals.mjs` | `~/.mo-agent/terminals.json`，含 `default` |
| `cli/lib/knowledge.mjs` | 记忆库路径与 `MO_AGENT_MEMORY` / recall limit |
| `cli/commands/memory.mjs` | `mo memory init` 的骨架写法 |
| `cli/commands/agent-add.mjs` | `mo agent add --mcp <file>` 的合并与备份逻辑 |
| `cli/commands/skill.mjs` | `AGENT_TARGETS` 与 `mo skill install` |
| `host/config.mjs` | `DEFAULTS` + `loadConfig(argv)`；**要改成也读配置文件** |
| `cli/commands/doctor.mjs` | 只读自检，`mo setup` 结尾复用它 |

约定：ESM，无构建步骤；错误用 `MoError(code, message, { hint })`；测试用 `node:test`。

## 第一批：`config.json` 与读取优先级

**路径**：`~/.mo-agent/config.json`，可用 `MO_AGENT_CONFIG` 覆盖（测试用）。

**优先级**（后覆盖前）：

```
DEFAULTS < config.json < 环境变量 < 命令行参数
```

**键**（只放全局、机器级；不要复制 workers.json / terminals.json 里的默认项）：

| 键 | 类型 | 默认 | 谁用 |
|---|---|---|---|
| `host` | string | `0.0.0.0` | daemon |
| `port` | number 1–65535 | `7788` | daemon |
| `authRequired` | boolean | `true` | daemon |
| `pollMs` | number ≥ 100 | `1500` | daemon |
| `logLevel` | `debug\|info\|warn\|error` | `info` | daemon |
| `recallLimit` | number 0–20 | `5` | CLI 派单注入 |
| `memoryPath` | string | 空（表示默认目录） | CLI |

**改 `host/config.mjs`**：读文件作为基底，再让现有 env / argv 覆盖。文件不存在 → 静默用默认；JSON 坏或字段非法 → **stderr 警告一行并继续**，不要崩。

**新增 `host/config.test.mjs`**：默认值、文件覆盖默认、env 覆盖文件、argv 覆盖 env、坏 JSON 不崩。

**新增 `cli/lib/config.mjs`**：

- `CONFIG_KEYS`：上面的键 + 校验函数 + 默认值；
- `readGlobalConfig({ home })` / `writeGlobalConfig({ home, patch })`；
- `effectiveConfig({ home, env })`：每个键返回 `{ value, source }`，`source ∈ default|file|env`（argv 只对 daemon 有意义，CLI 侧不显示）。

CLI 侧读取：`knowledge.mjs` 的 recall limit 改为 `MO_RECALL_LIMIT > config.recallLimit > 5`；`memoryPath` 同理（`MO_AGENT_MEMORY` > `config.memoryPath` > 默认目录）。

## 第二批：`mo config`

```bash
mo config list                 # 所有键：值 + 来源
mo config get port
mo config set port 7799
mo config set authRequired false
mo config unset port           # 回到默认
```

规则：

- `set` 校验类型与范围，非法值 `E_USAGE` + 提示合法范围；
- 未知键 `E_USAGE`，提示 `mo config list`；
- `list --json` 输出 `{ config: [{ key, value, source, default }] }`；
- 只写 `~/.mo-agent/config.json`，不碰环境变量、不碰 shell rc。

## 第三批：`mo setup`

幂等装配，串已有命令，不重写逻辑。

```bash
mo setup                 # 交互；非 TTY 时等同 --yes
mo setup --yes
mo setup --dry-run
mo setup --only memory,mcp
mo setup --skip skill
mo setup --json
```

**步骤**（每步：检查 → 已存在则 `⏭` → 否则执行）：

| # | 步骤 | 检测 | 动作 |
|---|---|---|---|
| 1 | 数据目录 | 目录存在 | 建 `~/.mo-agent/` 及 `ledger/ memory/ inbox/ approvals/` |
| 2 | 全局配置 | `config.json` 存在 | 缺的键补默认值，**已有值不动** |
| 3 | 记忆骨架 | `memory/README.md` 等存在 | 只补缺：`README.md`、`preferences.md`、`pitfalls/_template.md` |
| 4 | 默认执行者 | `defaultWorkerName()` 非空 | 列出已安装的内置 worker，`--yes` 取第一个，交互时让选；调 `setDefaultWorker` |
| 5 | 默认终端 | `currentTerminal()` 非空 | 探测 iTerm → Terminal.app，调 `setDefaultTerminal`；都没有设 `print` 并提示 |
| 6 | 技能 | `mo skill list` 里有已装目标 | 调现有安装函数；非 TTY 跳过并说明 |
| 7 | MCP | 目标配置里已有 `mo-agent` 条目 | 调 `mo agent add --mcp` 的合并逻辑；写前备份 |
| 8 | 汇总 | — | 跑 `doctor` 检查项，打印剩余动作 |

**硬约束**：

- 幂等：连跑两次，第二次必须全是 `⏭`；
- `--dry-run` 不写任何文件；
- 不碰仓库：**绝不**建 `project.json`、不写 `<repo>/.mo-agent/`、不改 `AGENTS.md`；
- 不启动 daemon、不装 Node、不动 PATH；
- 单步失败不中断其它步；有 `⚠`/`✗` 时退出码 1，否则 0；
- 步骤 6/7 如果无法安全检测（找不到配置文件），标记 `⏭ 跳过（原因）`，不要猜路径去写别人的配置。

## 文档与入口

1. `cli/lib/help.mjs`：加 `config` 组（list/get/set/unset）与 `setup` 组；
2. `cli/lib/complete.mjs`：`SPEC` 加两个命令，`TOP_LEVEL` 补 `config`、`setup`；同步 `cli/complete.test.mjs` 的期望数组；
3. `package.json`：`check` 追加新文件（`cli/lib/config.mjs`、`cli/commands/config.mjs`、`cli/commands/setup.mjs`、`host/config.test.mjs` 及新测试文件）；
4. `cli/README.md`：新增「全局配置」小节（`mo config` + `mo setup` 示例）；
5. `docs/guides/mo-cli.md`：命令速查表加两行 + 一段说明；
6. `docs/spec/workbench-flow.md`：
   - §13.4 改成实际行为（哪些做了、哪些没做）；
   - §12.7 的"命令缺口"表删掉 `mo setup` 行；
   - 新增 §12.8 记录本次实现（含 config.json 优先级）。

## 测试

新增：

- `host/config.test.mjs`：优先级链 + 坏文件容错；
- `cli/config.test.mjs`：默认值、set/get、非法值、未知键、unset、env 覆盖 list 显示、`--json`；
- `cli/setup.test.mjs`：空 home 全建、二次运行幂等（`--json` 里每步 `status: "skipped"`）、`--dry-run` 不写、`--only`/`--skip`、非项目目录可运行且不创建 `project.json`。

跑：

```bash
npm test          # 必须全绿
npm run check
```

## 提交

分 3–4 个提交，例如：

1. `feat(config): 全局 config.json 与读取优先级`
2. `feat(config): mo config list|get|set|unset`
3. `feat(setup): mo setup 幂等装配`
4. `docs: 记录全局配置与首次装配`

规矩：

- **显式 `git add <路径>`，禁止 `git add -A`**；
- 不要提交 `.mo-agent/`、`AGENTS.md`（它们必须保持未跟踪且不进 `.gitignore`）；
- 提交信息用中文，`type(scope): 一句话`，正文列要点。

## 验收标准

```bash
# 1. 干净 home 能一次装配
MO_AGENT_HOME=$(mktemp -d) node cli/mo.mjs setup --yes --json

# 2. 再跑一次全是 skipped
MO_AGENT_HOME=$(mktemp -d) node cli/mo.mjs setup --yes --json   # 先记 home
node cli/mo.mjs setup --yes --json                              # 同 home，应无写入

# 3. 配置可读写且来源正确
node cli/mo.mjs config set port 7799
node cli/mo.mjs config list --json
MO_AGENT_PORT=8123 node cli/mo.mjs config list --json   # port 应显示来源 env

# 4. daemon 真的读到了文件
#    改 config.json 的 port，起 host 时不用任何参数也能用该端口（可用 host/config.test.mjs 覆盖）

# 5. 不碰项目
cd /tmp && mkdir -p some-git && cd some-git && git init -q .
node /path/to/cli/mo.mjs setup --yes
# 期望：不出现 .mo-agent/，也不出现 project.json
```

## 不要做

- 不要在 config.json 里存 `pin` 或任何密钥；
- 不要新增"默认 worker/终端"的第二份存储（继续用 workers.json / terminals.json）；
- 不要做 `mo daemon start`（另开任务）；
- 不要改任务流、审批、派单相关代码。
