# mo CLI（P0）

个人工作台的最小执行闭环：**建卡 → 确认 → 派单 → 回执 → 归账**。

设计见 [docs/spec/workbench-flow.md](../docs/spec/workbench-flow.md)，架构见 [docs/architecture.md](../docs/architecture.md)。

## 安装

> **平台**：当前只支持 macOS 与 Linux（POSIX shell）。Windows 的差距与改造计划见
> [docs/plans/cli-cross-platform.md](../docs/plans/cli-cross-platform.md)，**暂不实现**。

只需要 Node 18+，没有任何第三方依赖。

### 两种安装顺序

| 你先有 | 怎么做 | 结果 |
|---|---|---|
| 想先装 mo | `bash scripts/install-cli.sh`（或远端 `install-remote.sh`） | 装好命令后，终端里会提示/直接进入技能安装 |
| 想先装技能 | `curl -fsSL .../skills/mo/SKILL.md -o ~/.agents/skills/mo/SKILL.md` | 主 Agent 首次使用时发现没有 `mo`，会停下来引导安装 |

两条路的终点一样：`mo` 在 PATH 里 + `~/.agents/skills/mo/SKILL.md`（按需复制到各 Agent 目录）。

**方式一：安装脚本（推荐）**

```bash
bash scripts/install-cli.sh                # 安装单文件二进制（已构建则复用）
bash scripts/install-cli.sh --link         # 开发模式：软链到源码，改完立即生效
bash scripts/install-cli.sh --rebuild      # 强制重新构建
bash scripts/install-cli.sh --no-completion  # 只装命令，并清掉旧补全块
bash scripts/install-cli.sh --completion bash  # 补全写到 ~/.bashrc
bash scripts/install-cli.sh --uninstall    # 卸载（含补全块）
MO_BIN_DIR=/opt/bin bash scripts/install-cli.sh   # 指定安装目录
```

脚本做两件事：

1. **默认安装单文件二进制**（和 Release 里分发的是同一个产物），拷到 `~/.local/bin/mo`；没有 bun 时退化为源码软链并提示；
   - 产物是 `cli/dist/mo`（本地构建不带版本和平台，`mo --version` 看版本；发布时才由 CI 重命名）；
   - 产物比 `cli/`、`core/tasks/`、`package.json` 都新时**直接复用，不重复构建**；
   - 想强制重建用 `--rebuild`；
2. 按 `$SHELL` 把补全块写进 `~/.zshrc` / `~/.bashrc`——用注释标记包围，重装只更新这一段，删掉该段即关闭。

两种安装方式的区别：

| 方式 | 装的是什么 | 依赖 | 适用 |
|---|---|---|---|
| 默认 | 61MB 自包含二进制 | 无（bun 只在构建时需要） | 日常使用；仓库挪走也不影响 |
| `--link` | 指向 `cli/mo.mjs` 的软链 | 源码 + Node | 改 CLI 时免构建 |

安装记录写在 `~/.mo-agent/install.json`（`mode` / `bin` / `entry`），`--uninstall` 靠它精确清理。

对应的 npm 脚本（命名统一为 `cli:` 前缀）：

| 命令 | 作用 |
|---|---|
| `npm run cli:build` | 构建 `cli/dist/mo` |
| `npm run cli:install` | 装到 PATH 并写补全 |
| `npm run cli:demo` | 跑四场景演示 |
| `npm run cli:version:check` | 校验 `cli/lib/version.mjs` 与 `package.json` 一致 |

写 rc 前会备份为 `*.mo-agent.bak-<时间>`；最后跑一次 `mo doctor`。

装完会打印一段**当前终端执行即可启用补全**的脚本（不用重开终端）：

```bash
hash -r 2>/dev/null; eval "$(mo completion zsh)"
```

（脚本是子进程，改不了你当前 shell 的环境，所以只能把这条命令打印出来让你执行。）

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
bash cli/demo/run.sh
```

在临时目录里自动跑四个场景。想在自己的目录里一步步做，按 [demo/README.md](demo/README.md) —— 那是一份带预期输出和通过标准的手动测试用例。

四个场景，全部本地、不联网、不花钱：

| 场景 | 期望 |
|---|---|
| 正常完成 | 执行者写合法回执 → `done` |
| 没写回执 | `blocked(missing_receipt)`，退出码 0 也不算成功 |
| 回执非法 | `blocked(bad_receipt)`，例如 `done` 却没有验收证据 |
| 卡住后重试 | `blocked → running → done`，账本留下完整时间线 |

## 第一次使用

```bash
mo doctor                 # 自检：node / home / 项目
cd ~/c/work/your-project
mo project add .          # 认领项目，写 .mo-agent/project.json
```

然后建第一张卡。`--exec` 是**任意 shell 命令**，不绑定任何厂商，只有一个要求：

> 从 stdin 读任务卡，把回执写到 `$MO_RECEIPT`。

常用 Agent 有内置模板，用 `--agent` 选，不用记完整命令：

```bash
mo agents                        # 列出模板
mo task create --agent claude …  # 展开成 claude -p "$(cat)"
mo task create --agent codex …
```

| 模板 | 展开为 | 说明 |
|---|---|---|
| `claude` | `claude -p "$(cat)" --permission-mode acceptEdits` | Claude Code |
| `codex` | `codex exec -s workspace-write -` | Codex CLI |
| `qodercli` | `qodercli -p "$(cat)" --permission-mode accept_edits` | Qoder CLI（国际版） |
| `qoderclicn` | `qoderclicn -p "$(cat)" --permission-mode accept_edits` | Qoder CLI（CN 版） |
| `pi` | `pi -p "$(cat)"` | pi |
| `qwen` | `qwen --approval-mode auto-edit "$(cat)"` | Qwen Code |

`mo agents` 会标出每个模板在本机**是否已安装**（按 `requires` 里的可执行文件查 PATH）。

模板都选了"能写文件"的模式——执行者必须能写 `$MO_RECEIPT`，只读模式跑出来的任务永远到不了 `done`。

需要别的参数就用 `--exec` 写完整命令（两者互斥）：

| 执行者 | `--exec` 写法 | 备注 |
|---|---|---|
| 自己的脚本 | `node scripts/run-task.mjs` | 最可控 |
| 纯 shell | `bash -lc 'cat >/dev/null; printf ... > $MO_RECEIPT'` | 应急 |
| 先演示 | `node /…/cli/demo/executor.mjs` | 仓库自带的假执行者，不花钱 |

模板只是建卡时的默认值：派单时 `--agent` / `--exec` 可以覆盖卡里的命令。

**执行者能不能用，先手动验一次**：

```bash
echo "说一句 OK" | claude -p "$(cat)"        # 能出字就说明登录正常
echo "说一句 OK" | codex exec -s workspace-write -
```

看到 `Not logged in` 就是没登录，先解决登录再派单；否则会得到 `blocked(missing_receipt)`。

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

## 分发给别人

不要求对方 clone 源码。三条路。

### A. GitHub Releases + 一行安装（推荐）

打 tag（例如 `v0.2.0`）后，`.github/workflows/cli-release.yml` 会自动：

- 跑 `npm test`
- 用 bun 交叉编译四个平台：`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64`
- 为每个产物生成 `.sha256`
- 打 npm 包
- 全部挂到 Release

对方只需要一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/scripts/install-remote.sh | bash
```

脚本会按 `uname` 选产物、校验 sha256、装到 `~/.local/bin/mo`。

指定版本或在本地验证：

```bash
MO_VERSION=v0.2.0 bash scripts/install-remote.sh
MO_CLI_BASE_URL=file://$PWD/cli/dist bash scripts/install-remote.sh
```

仓库地址已写成 `insky2005/mo-agent`；fork 或换仓库时用 `MO_AGENT_REPO=you/mo-agent` 覆盖。

**私有仓库注意**：Release 资产需要登录才能下载，`curl` 一行安装会 404。要么仓库公开，要么改用 npm 私有源（方式 B/C 仍可用）。

### B. 从 GitHub 直接装 npm 包

对方有 Node 时，连 tarball 都不用传：

```bash
npm i -g github:insky2005/mo-agent
```

npm 会自己拉仓库，并按 `package.json` 的 `files` 只装 `cli/` + `core/tasks/` + `core/errors.mjs`。

### C. 手动下载二进制

Release 页面下载 `mo-darwin-arm64`（约 61MB），`chmod +x` 后放进 PATH：

```bash
chmod +x mo-darwin-arm64 && mv mo-darwin-arm64 /usr/local/bin/mo
```

### 本地出包

```bash
bash scripts/build-cli.sh                 # → cli/dist/mo
TARGET=bun-linux-x64 bash scripts/build-cli.sh   # → cli/dist/mo-linux-x64（交叉编译不带版本）
npm pack --pack-destination cli/dist      # → cli/dist/mo-agent-0.2.0.tgz（约 25KB）
```

## 接到主 Agent

把技能装到主 Agent 的技能目录，之后在对话里说“开始做”就行，不用手敲命令。

```bash
mo skill install                 # 交互选择装到哪些 Agent
mo skill install --yes           # 不问，直接用默认（通用位置 + 已装的 Agent）
mo skill list                    # 看每个目标装没装
mo skill uninstall
mo skill install --target claude # 只装某个 Agent，不提问
mo skill install --target /some/skills
```

交互长这样：

```text
为哪些 Agent 安装 mo 技能？

  1) [x] agents      ~/.agents/skills
  2) [x] claude      ~/.claude/skills
  3) [ ] codex       ~/.codex/skills（未安装）
  4) [x] qwen        ~/.qwen/skills

选择：1,3 收尾 | a 全选可用 | 回车 用默认 | q 取消
```

非交互环境（管道、CI）会自动走默认，不会卡住。

| 目标 | 路径 | 默认 |
|---|---|---|
| `agents` | `~/.agents/skills/mo` | 总是装（通用位置） |
| `pi` | `~/.pi/agent/skills/mo` | 仅 `--target pi`；pi 也读 `~/.agents`，**别两处都装** |
| `claude` | `~/.claude/skills/mo` | 目录存在时 |
| `codex` | `~/.codex/skills/mo` | 目录存在时 |
| `qodercli` | `~/.qoder/skills/mo` | 目录存在时 |
| `qoderclicn` | `~/.qoder-cn/skills/mo` | 目录存在时 |
| `qwen` | `~/.qwen/skills/mo` | 目录存在时 |

`pi` 有两个来源：原生的 `~/.pi/agent/skills/`，以及 Agent Skills 规范的 `~/.agents/skills/`（含项目级 `.agents/skills/`）。
默认只装 `~/.agents` 一处就够了；`--target pi` 是给想放进 pi 自己目录的人用的——**两处都装会触发同名冲突**，pi 只保留先发现的那份并告警。

### 用 skills CLI 安装

本仓库符合 skills 生态的布局（`skills/<name>/SKILL.md`），可以直接：

```bash
npx skills add insky2005/mo-agent       # 装到 ~/.agents/skills/mo
npx skills update mo                # 之后更新
```

这条路**不需要先装 mo**：技能会先就位，主 Agent 首次使用时发现没有 `mo` 会停下来引导安装。
仓库需要公开（或对方有读权限）。

### 用 mo 自己装

技能内容内联在 CLI 里，所以单文件二进制也能装。还没有 `mo` 时用脚本引导：

```bash
bash scripts/install-skill.sh [--uninstall]
```

技能内容见 [skills/mo/SKILL.md](../skills/mo/SKILL.md)：什么时机建卡、派单前必须回显、失败怎么转述、七条铁律。

接好之后怎么验证它真按流程走：见 [demo/agent-test.md](demo/agent-test.md)（六个用例，不需要登录执行者也能测四个）。

**mo 还没装时**，技能会让 Agent 先说明情况并征得同意，然后由它执行安装（下载到临时文件再运行，不走 `curl | bash`），装完用绝对路径继续。不同意就只给命令、停下。

**装完要新开会话**——技能目录在会话启动时加载。

没有技能机制的 Agent，可以让 mo 直接写进去：

```bash
mo agent init                 # 自动选 AGENTS.md / CLAUDE.md，按是否已装技能决定内容
mo agent init --mode inline   # 强制写完整用法（不依赖技能）
mo agent init --file docs/AI.md
mo agent remove               # 只删自己那段
```

- **技能已安装**：只写一段指针，说明"按 mo 技能走"；
- **技能未安装**：写完整用法（建卡 → 确认 → 派单 → 汇报）。

两种内容都用 `<!-- >>> mo >>> -->` 标记包围，重跑只替换这一段、不动其它内容。

也可以手动把下面这段贴进项目的 `CLAUDE.md` 或 `AGENTS.md`：

```text
要把讨论落地时，用 mo CLI：
1) 先补齐交付物、验收标准、边界，再 mo task create --agent <claude|codex|qodercli|qoderclicn|pi|qwen>；
2) 把卡摘要给用户，等确认；
3) 确认后 mo task confirm，再 mo task dispatch；
4) 只按 mo task status / mo ledger 的实际结果汇报，不要替执行者宣称完成。
执行者没写回执（missing_receipt）一律视为未完成。
```

> 目前是 CLI 形态：Agent 通过 shell 调 `mo`。MCP 端点、被唤醒（inbox）还没做，属 P1 的后半段。

## Tab 补全

支持 bash 与 zsh：命令、子命令、选项，以及**任务 id（带状态和标题）**、`--project` 的项目名。

`scripts/install-cli.sh` 会自动装好；手动安装见下。

```bash
# zsh
echo 'eval "$(mo completion zsh)"' >> ~/.zshrc

# bash
echo 'eval "$(mo completion bash)"' >> ~/.bashrc
```

重开终端后：

```text
mo task <TAB>              create confirm cancel status list dispatch
mo task confirm <TAB>      t_01M5…:draft 任务面板加筛选
mo task create --ti<TAB>   --title --timeout
mo ledger query --project <TAB>   demo  other-project
```

实现上是一个隐藏回调 `mo __complete`，shell 脚本把当前行交给它；脚本本身很短，可先 `mo completion zsh` 看一眼再 eval。

没有候选时回退到 shell 默认（bash 的文件名补全、zsh 的 `_files`），所以 `--file` 这类路径参数照常可用。
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