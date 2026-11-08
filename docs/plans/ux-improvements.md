# 易用性改进说明：入口、确认、导航

状态：已落地（分批完成，见 §8 进度与「有意偏离」）　日期：2026-11-08　依据：0.3.0 + Router 的一次全量评审（读码 + 实测）
关联：[architecture.md](../architecture.md)、[spec/workbench-flow.md](../spec/workbench-flow.md)、[spec/router.md](../spec/router.md)、[adr-0001](../adr/adr-0001-observational-first.md)、[adr-0004](../adr/adr-0004-private-router-runtime.md)

---

## 0. 目标与验收

两句话：**易用、不混乱**；**安装、配置、使用一目了然，简单便捷**。

拆成可判定的验收标准（不达成就不算完成）：

| # | 标准 | 判定方法 |
|---|---|---|
| G1 | 新用户在 **3 分钟内**完成第一次成功（收到一条通知，或一张卡跑完） | 找 3 个没看过文档的人计时 |
| G2 | 第一次成功**只读一份文档**，且不需要问人 | 同上，记录他们点开了几个文件 |
| G3 | 任何入口都能回答“我在哪、下一步做什么” | 每条入口的第一屏都有这句 |
| G4 | 三个入口的**同一个动作表现一致**（尤其“批准”） | 对照能力矩阵逐条走一遍 |
| G5 | 从“想法”到“卡跑完”**不离开当前对话**（Agent 入口） | 全程不敲终端命令 |

---

## 1. 诊断：用户为什么“不知道怎么用”

### 1.1 三个入口在文档里互不相认（实测）

| 入口 | 谁发起 | 现状文档覆盖 |
|---|---|---|
| **CLI 直接使用** | 人 | [USAGE.md](../../USAGE.md) 完整；[README.md](../../README.md) 里 mo task 出现 **0 次** |
| **外部 Agent + 技能 + MCP** | 已有的 Claude / DSH / Qoder | [skills/mo/SKILL.md](../../skills/mo/SKILL.md) 有，但**不提 Router（0 次）** |
| **内置 Router + MCP** | 指挥台 | README / USAGE / INSTALL / cli README / mo-cli 指南里出现 **0 次**；只在 mo help router 与内部 docs |

用户不是选不过来，是**不知道自己有三条路**。另外 [docs/README.md:49](../README.md) 仍把 router 标成「🟡 设计（未实现）」，而 [architecture.md](../architecture.md) 已写“0.3.0 + Router”——两份总览互相矛盾。

### 1.2 一次真实旅程的断点（实测）

    人：就这么办
     └─ Agent / 指挥台：task_create → draft
        Agent：task_confirm → 落盘请求 a_xxx
          ├─ 客户端支持 elicitation → 对话里弹「允许/拒绝」  ← 唯一人工动作（但只显示标题）
          └─ 不支持               → 返回 pending …… 然后没有然后（无推送）
        Agent：task_dispatch → 派单、验收、终态

三个断点，全部实测或代码可证：

1. **确认请求没有通知。** task.confirm_requested 只写账本（[cli/lib/approvals.mjs:79-85](../../cli/lib/approvals.mjs)），[spec/event-contract.md](../spec/event-contract.md) 的通知策略里没有 task 类事件，host 不消费 → 手机不亮、监控屏不动。
2. **批准之后没有回程票。** inbox 只收 done / blocked / failed / canceled / expired（[cli/lib/inbox.mjs:22](../../cli/lib/inbox.mjs)）。ROUTER.md 第 3 步要求“停下等批准”（[core/manager/contract.mjs:438](../../core/manager/contract.mjs)），但**批准结果没有任何通道能叫醒 Router**。
3. **手机批准了任务卡，却不派单。** decideTaskApproval 只改请求状态（[host/task-approvals.mjs:53](../../host/task-approvals.mjs)），派单仍是 mo task dispatch，没有 HTTP 入口。

### 1.3 契约与实现不一致（会让 Agent 静默失败）

| 位置 | 告诉用户/Agent 写 | 实现真正接受 |
|---|---|---|
| [core/manager/contract.mjs:26](../../core/manager/contract.mjs)（Agent 的 schema） | check:文件含X | 「路径 存在」/「路径 包含 文本」（[cli/lib/verify.mjs:134-141](../../cli/lib/verify.mjs)） |
| [USAGE.md](../../USAGE.md)（人的表格） | check:文件存在 | 同上 |

实测：照文档写 → kind=unknown → needs_human → 卡进 blocked，**不报错**。Agent 完全照 schema 写，所以这是“必踩”，不是“可能踩”。

---

## 2. 目标形态

### 2.1 一条默认路径

**默认门 = 内置 Router（指挥台）。** 理由：它是唯一由 mo 自己控制交互的主 Agent，能保证“确认”这步的体验一致；另外两条本质是它的降级形态（外部 Agent = 借别人的主 Agent；CLI = 手动挡）。其余两条保留，但在文档与 mo help 里标为**进阶**。

### 2.2 一张能记住的选择表

| 你的情况 | 用哪条 | 第一条命令 |
|---|---|---|
| 只想被通知、随手批准 | 桌面 App + 手机 | 装 App → 扫两码 |
| 已经在 Claude / DSH 里干活 | 外部 Agent + 技能 + MCP | mo skill install → mo agent add --mcp |
| 没有主 Agent，或不想开外部 Agent | **Router（默认）** | mo router start |
| 脚本 / CI / 排障 / 无 GUI | CLI | mo task … |

### 2.3 安装、配置、使用的目标旅程

| 阶段 | 目标 | 现状 | 差距 |
|---|---|---|---|
| 安装 | **1 个动作** | 桌面包（1 动作）或 get-cli.sh（1 动作） | 已达标；但“装了 CLI 还要 mo daemon install 才有完整能力”没提前说 |
| 配置 | **1 个入口、≤3 个问题** | 桌面菜单“一键配置 Agent”与 mo setup 两条并行，Router 配置是第三条 | 三条入口之间没有选择规则 |
| 使用 | **一个默认路径 + 任何入口都有“下一步”** | 三入口各自为政 | 见第 3 节 A / B 项 |

---

## 3. 改进清单

### A. 入口与导航（直接对应“不混乱”）

| # | 问题 | 改法 | 验收 |
|---|---|---|---|
| A1 | 无默认入口 | mo setup 结尾问一句“现在启用指挥台吗”；桌面菜单加“打开指挥台” | 走完 setup 就知道默认路径 |
| A2 | 选择规则没有真源 | 在 [core/manager/contract.mjs](../../core/manager/contract.mjs) 加 ENTRY 段，由 render() 注入 SKILL.md 与 describe；README、USAGE 顶部放同一段 | 一段文案四处一致，check 校验 |
| A3 | 用户不知道自己在哪条路 | mo doctor 增加“建议入口”：检测技能是否已装 / router 凭据是否存在 / 有没有任务卡，给一条可执行命令 | doctor 输出的最后一块永远是“下一步” |
| A4 | 文档漂移 | 改 [docs/README.md:49](../README.md) 的「未实现」；[architecture.md](../architecture.md) §3 代码量按实测更新（cli 11.1k、host 9.8k） | 两份总览一致，数字与实测吻合 |
| A5 | 命令面 30 组，新手一眼茫然 | mo help 默认只显示 5 条主路径，mo help --all 才是全量；主路径里 Router 在第一位 | 新手 mo help 不用滚动就能读完 |
| A6 | README 与 USAGE 像两个产品 | README 首屏分两段：“只看不改（监理）”“要派活（工作台）”，各一句话 + 一条命令 | 只读 README 就知道两条产品线存在 |
| A7 | 手机页已有“任务卡确认”，文档没写 | 明确写“任务卡可以在手机上批”，并说明批准后仍需派单 | 文档与实现一致，无隐藏功能 |

### B. 流程通电（对应“使用便捷”）

| # | 问题 | 改法 | 验收 |
|---|---|---|---|
| B1 | 确认请求无人通知 | host 消费 task.confirm_requested（或 watch ~/.mo-agent/approvals/），发一条 notify | 手机/桌面收到“有卡等你批准”，点开能批 |
| B2 | 批准后没有回程票 | 批准/拒绝写 inbox（新增 task.confirmed / task.rejected），Router 下轮 pull 到就继续 | 指挥台在无人催促时自动派单 |
| B3 | 手机批准后不派单 | host 增加派单入口（复用架构 §9 的 host/runner）；无 host 时保持只改状态 | 手机上“批准并派单”一次完成 |
| B4 | dispatch 同步阻塞（headless 默认 45m） | 加 --detach：立即返回 running + taskId，结果走 inbox；MCP 的 task_dispatch 同时给 async 形态 | 派单不占终端，也不挂死 Agent 的工具调用 |
| B5 | running 状态下可再次派单，会双跑 | dispatchable 去掉 running；要重派必须显式 --force | 同一张卡不会有两个执行者写同一个回执 |

### C. 语法与文案（对应“一目了然”）

| # | 问题 | 改法 | 验收 |
|---|---|---|---|
| C1 | check: 语法契约与实现不一致 | 二选一：实现接受裸路径（默认“存在”）；或把 schema 与文档改成实现语法并加测试 | 照文档写必然通过；单测覆盖两种写法 |
| C2 | blocked 一律提示“重试” | 按 reason 分流：missing_receipt / timeout → 重试；bad_receipt / needs_human / verify_failed → 改验收或看日志 | 三种原因给出三种下一步 |
| C3 | task list 只有 id / 状态 / 标题 | 加两列：**待办**（待批 / 待重试）、**验收**（verified / unverified / failed） | 多卡时不用逐张 status |
| C4 | 单人自用要 create → confirm → approve 三次 | TTY 下 create 末尾问“现在批准并派单吗”；保留指纹校验与批准动作 | 一次交互完成，仍由人点头 |
| C5 | 确认时看不到卡内容 | elicitation 表单与终端 approve 显示**交付物 + 验收项**（现在只有标题与“验收 N 项”） | 人能看着内容点头 |
| C6 | Router 契约缺错误处理表 | 把 E_CARD_CHANGED / E_NOT_CONFIRMED 的处理指引补进 ROUTER.md | 卡被改动时 Router 会重新 confirm，而不是重试 approve |

### D. 支撑项（不直接服务两条目标，排在后面）

| # | 问题 | 说明 |
|---|---|---|
| D1 | cli/lib 是 host 也依赖的共享内核，却没有纯度守卫 | host 已 import 8 处（router-manager / approvals / project / paths / config / fsx）；建议拆出 kernel/（禁 stdout、禁 argv）并加守卫测试 |
| D2 | host 内部无模块图 | 补一张，并把各通道收敛到同一个 notifier 接口，避免新增通道复制粘贴 |
| D3 | 通知无静音时段；去重表满 500 条整表清空（[core/notify.mjs:68](../../core/notify.mjs)） | 手机是主消费端，建议加 quiet hours 并修去重逻辑 |
| D4 | 语音批准要念随机数字 | 改口语词（“红-苹果-三”），降低识别失败 |

### E. CLI 命令面收敛（“不混乱”的主体）

**现状规模（实测）**：21 个顶层组、约 60 个子命令、68 个不同长选项，mo help 首屏 44 行。一条从建卡到 done 的主路径要敲 4 条命令。

**六种乱法，逐条给出禁止规则**：

| # | 乱法 | 证据 | 规则（今后不许再出现） |
|---|---|---|---|
| E1 | 同一个“建”有五种动词 | create / init / add / install / setup 各占一块 | 建东西只用 **create**；只有“下载二进制到本机”才用 install |
| E2 | 同一个“看”有六种动词 | list 7 处、status 3 处、current 2 处，另有 requests / candidates / describe | 列列表只用 **list**；看单个或当前只用 **show** |
| E3 | 同一个词三种意思 | mo agent（接外部主 Agent）、project agent（写 AGENTS.md）、worker 的前身也叫 agent | 一个概念只留一个词；接入外部 Agent 改 **mo connect** |
| E4 | 两个常驻服务像兄弟 | daemon 有 open 没有 restart；router 有 restart 没有 open；router 起 host 靠 router start --start-daemon | 合成一个 **mo serve**，router 是它的一个形态 |
| E5 | 内部命令摆在用户面 | receipt submit / apply、watchdog run、mcp、completion、__complete | 收进 **mo internal <x>**，mo help 默认不显示 |
| E6 | 同一份 help 内部就重复 | mo help daemon 里 open 出现 4 次、两种参数写法；status 标“默认子命令”而 router 默认是 start | 每个子命令在 help 里只出现一次；默认子命令要一致 |

**目标命令面（用户面 7 组）**：

| 组 | 子命令 | 说明 |
|---|---|---|
| （无组） | setup / doctor / connect / upgrade | 一次性动作直接放顶层，不多包一层 |
| task | create list show approve reject dispatch verify cancel logs | 主路径 |
| project | create list remove | |
| worker | list add remove use | use 不带参数 = 当前默认（吃掉 current） |
| memory | list recall propose candidates accept reject | init / migrate 收进 internal |
| ledger | query | 只读，动词即动作 |
| inbox | pull list | 结果队列，不是 CRUD |
| serve | start stop restart status open | daemon + router 合并；router 走 serve router |
| config | list get set unset | 已是好命名，保留 |
| internal | mcp receipt watchdog completion router-runtime | 机器用，不进主 help |

**验收指标（可测）**：

| 指标 | 现在 | 目标 |
|---|---|---|
| mo help 首屏行数 | 44 | ≤ 12 |
| 用户面子命令数 | 约 60 | ≤ 35 |
| “准备类”动词种类 | 5 种（create/init/add/install/setup） | 2 种（create / install） |
| 同名不同义的词 | 3（agent） | 0 |
| 建卡到 done 的命令数 | 4 | 3（配合 C4 合并 create 与 approve） |

**专有动词例外**：每个域最多留两个领域动作（task 的 dispatch / approve / verify、memory 的 recall / propose、inbox 的 pull），其余一律回到通用动词表。这是“一眼能猜出来”和“精确表达”的折中。

**迁移方式**：旧命令保留为别名，跑一次打一行 deprecation 警告，保留一个发布周期后移除。历史教训：--agent 改名 --worker 时直接抛错、没有别名（[cli/commands/task.mjs:33-35](../../cli/commands/task.mjs)），用户被迫改脚本——这类改名今后一律走别名过渡。

---

## 4. 落地顺序

### 批次 1：不混乱（约 1 周，纯文档与文案，零风险）

A2 选择表真源、A4 文档漂移、A6 README 分段、A5 help 收敛、A1 默认门提问；C1 check 语法（改文案 + 加测试）；E5 内部命令收纳、E6 help 去重。

**产出**：任何人打开 README 就知道有三条路、该走哪条。**验收**：G2、G3、G4。

### 批次 2：通电（约 1–2 周，四处小改动）

B1 确认→通知、B2 批准→inbox、B4 dispatch --detach、B5 防双跑；C2 分流文案、C3 列表加列、C5 表单显示内容、C6 Router 补错误表；E1–E4 动词归一与 serve 合并（全部带别名过渡）。

**产出**：Agent 发起、人点一次、Agent 自己继续；CLI 不再占住终端。**验收**：G5；手机能收到“卡等人批”并完成批准。

### 批次 3：闭环（依赖 host 派单能力）

B3 手机批准即派单（复用 host/runner）、A3 doctor 入口建议。**验收**：G1（3 分钟首次成功）。

### 批次 4：支撑性重构

D1 cli/lib 拆分与守卫、D2 host 模块图、D3 通知节流、D4 语音口令。

---

## 5. 明确不做

- **不砍任何入口**：三者服务三类人（脚本 / 已有主 Agent / 不想装主 Agent），砍掉会丢用户。
- **不取消批准**：“没有你的决定就不放行”是产品原则；C4 只合并交互，不合并权限。
- **不为统一而重写**：批次 1 全部是文案与文档；批次 2 的每处改动都落在一个函数内。
- **不把 CLI 改成依赖 host**：CLI 独立可运行是架构不变量（[architecture.md §5](../architecture.md)）。

---

## 6. 附录：本次实测记录

### 6.1 依赖边（独立扫描，与 architecture.md §5 一致）

    cli → core 63   host → core 9   host → cli 8   host → adapters 4
    host → approvals 4   adapters → core 8   approvals → core 2   cli → host 0

### 6.2 代码量（.mjs；源码 / 测试）

| 目录 | 源码 | 测试 |
|---|---|---|
| core | 2 199 | 958 |
| cli | 11 127 | 4 932 |
| host | 9 755 | 5 438 |
| adapters | 2 868 | 1 839 |
| approvals | 460 | 245 |

测试文件共 167 个；core 只 import node:crypto，无 fs / path / os。

### 6.3 一次 CLI 全流程（隔离 home 实测）

    task create            → draft
    task dispatch（未确认）  → [E_NOT_CONFIRMED] exit 1
    task approve（无请求）   → [E_NOT_FOUND] exit 1
    task confirm           → 请求 a_xxx，卡仍 draft
    task approve --yes     → confirmed（账本 actor=human, channel=cli-flag）
    task dispatch          → dispatched → running → done / verified
    done 再 dispatch        → [E_NOT_CONFIRMED] 不能派单

失败路径同样成立：不写回执 → blocked/missing_receipt（退出码 0 也不算成功）；回执非法 → blocked/bad_receipt；check 写错 → blocked/needs_human（**静默，无报错**）。

### 6.4 手机端能力（已实现，非规划）

/api/state、/api/events、/api/approvals、/api/task-approvals、/api/approve、/api/answer、/api/prompt、/api/cancel。[app/web/index.html](../../app/web/index.html) 同时加载 app.js（会话列表、授权与提问、发指令）与 approvals.js（任务卡确认，5 秒轮询）。/monitor 仅本机可访问，属于桌面监控屏，与手机是两条通道。
---

## 7. 整理后的 CLI 工作流（目标态）

> 这一节描述的是**收敛之后**的用户视角，用于评审方向；当前实现仍是 §1 描述的样子。

### 7.1 第一屏只有一条路径（mo help ≤ 12 行）

    mo —— 想法 → 任务卡 → 人批准 → 派单 → 验收 → 账本

    第一次用
      mo setup                    装配（幂等）；最后问你走哪条路
      mo doctor                   自检；最后一行永远是“下一步”

    干活
      mo task create …            建卡（TTY 下顺带问：现在批准并派单吗）
      mo task show <id>           状态 / 验收 / 待批 / 结论
      mo task list                本项目全部卡
      mo inbox pull --wait 10m    等结果（或让 serve 把通知推到手机）

    常驻与接入
      mo serve start              常驻服务（手机、钉钉、监控屏）
      mo connect                  接入外部 Agent（技能 + MCP）

    全部 8 组：mo help --all

### 7.2 一个状态只对应一条“下一个动作”

| 卡片状态 | 该做什么 | 命令 |
|---|---|---|
| draft | 请人批准 | mo task approve <id>（或 TTY 下 create 时一并完成） |
| confirmed | 派单 | mo task dispatch <id> |
| running | 等，或看日志 | mo task show <id> / mo task logs <id> |
| blocked | 先看原因，再决定 | mo task show <id> → 重试或改验收 |
| done | 复核 | mo task verify <id> |
| canceled / expired | 重建 | mo task create … |

### 7.3 一条主路径：从想法到 done（3 条命令）

    cd 项目 && mo project create && mo worker use claude-headless   # 一次性

    mo task create --title "加 daemon 命令" \
                   --deliverable "cli/commands/daemon.mjs" \
                   --verify "run:npm test"
      → 回显 taskId 与卡片内容
      → TTY 下问：现在批准并派单吗？(y/n)
      → y：一步完成 confirmed + dispatched

    mo task show t_xxx        # 状态、验收、结论

后台派单（不占终端）：

    mo task dispatch t_xxx --detach
    mo inbox pull --wait 10m

### 7.4 三种人，同一件事

同一个动作在三条通道上必须是同一个词，不许有第三种说法：

| 动作 | CLI | MCP 工具 | 指挥台 |
|---|---|---|---|
| 建卡 | mo task create | task_create | 同左（无 shell，只能走 MCP） |
| 发起确认 | mo task confirm | task_confirm | 同左 |
| 人的决定 | mo task approve / reject | **不暴露**（只许 elicitation 问人） | 不暴露 |
| 派单 | mo task dispatch | task_dispatch | 同左 |
| 看状态 | mo task show | task_status | 同左 |
| 等结果 | mo inbox pull | inbox_pull | 同左 |
| 查事实 | mo ledger query | ledger_query | 同左 |

### 7.5 三句话判据（不用记命令）

1. **它现在怎么样？** → mo task show <id>
2. **刚才发生了什么？** → mo ledger query
3. **我该做什么？** → mo inbox pull（待办）或 mo doctor（环境）

危险动作（批准 / 派单 / 取消）一律要指名 taskId，不存在“批量顺手过”。

---

## 8. 进度

状态：**全部条目已收口**，包括原先记在「有意偏离」与「后续可选」里的三项。
最后一次验证：`npm test` **726 项、0 失败**；`npm run voice:test` **126 项、0 失败**；`npm run check` 通过。

### 已完成

| 项 | 内容 |
|---|---|
| A1 | `mo setup` 交互时会问「现在配置指挥台？」（已存在，核实无需改） |
| A2 | 契约新增「三条路」段；SKILL.md 与 `mo agent describe` 同源重生成 |
| A3 | `mo doctor` 末行给「建议入口」（按技能 / 指挥台 / 任务卡三种信号） |
| A4 | 文档漂移修正：docs 索引 router 标为生效、architecture 代码量、守卫断言 `cli→host` 必须为 0 |
| A5 | `mo help` 默认 11 行主路径，`mo help --all` 才是全部分组 |
| A6 | README 首屏「先选一条路」四入口对照表 |
| A7 | USAGE/指南写明「任务卡可以在手机上批」与批准/派单的分工 |
| B1 | host 扫描 `approvals/` 发正式的 `task.confirm_requested` 事件（`host/task-watch.mjs`），payload 带交付物与验收项 |
| B2 | 批准/拒绝写 inbox（`task.confirmed` / `task.confirm_rejected`），任务出结果时自动清掉 |
| B3 | 手机「允许并派单」：`/api/task-approvals/:id` 支持 `dispatch:true`，host 用卡上的 exec / 默认执行者后台派单 |
| B4 | `dispatch --detach`：先占位再 spawn 自己，立即返回 pid + 日志；顺带修掉 `dispatched` 卡派单后卡住的漏洞 |
| B5 | `running` 拒绝重复派单，需 `--force`；新增 `E_ALREADY_RUNNING` |
| C1 | `check:` 接受裸路径；契约与 USAGE 示例同步；写错不再静默 `needs_human` |
| C2 | `blocked` 的下一步按 reason 分流（重试 / 看验收 / 看日志 / 看提问） |
| C3 | `task list` 增加「待办 / 验收」两列 |
| C4 | TTY 下 `task create` 末尾问「现在批准并派单吗」，一次交互完成确认+批准+后台派单 |
| C5 | `approve` 的确认框显示交付物与验收项 |
| C6 | Router 契约补「遇到这些返回怎么办」表 |
| D1 | **`cli/lib` 拆出 `cli/ui/`**（argv 解析 / 输出 / help / 弃用提示），内核与界面层物理分开；三条结构守卫锁住方向 |
| D2 | `docs/architecture.md` §3.1：host 内部模块七分组 + 通道统一契约 |
| D3 | 静音时段 `quietHours`；去重表改逐条淘汰；`notify.json` 走数据目录 |
| D4 | 语音口令从 4 位数字改成 3 个口语词；两种格式都兼容；修好 `npm run voice:test` 在 Node 22 上的问题 |
| E1–E6 | 命令面收敛：`serve` / `connect` / `internal` / `task show` / `project create` / **`memory create`** / **`connect project`** / **`worker·terminal use` 吃掉 current**；旧名字全部保留为别名；`memory migrate` 收进 `internal memory-migrate`；补全与 help 同步 |
| E-收口 | **弃用登记表**（`cli/ui/deprecate.mjs`）统一登记旧命令、提示新位置并写明 **0.5.0 移除**，同一进程只提示一次 |
| 新增 | **`note_write`**：`~/.mo-agent/notes/YYYY-MM-DD-<slug>.md`，不接受路径、append-only、单篇 64KB 上限；链路上是 `MCP note_write → mo internal note-write → cli/lib/notes.mjs`，账本记 `note.written` |
| 新增 | 手机任务卡确认卡片会显示**交付物与验收项**，并响应 `task.confirm_requested` 事件即时刷新（不再等 5 秒轮询） |
| — | `MO_AGENT_HOME` 贯穿 daemon/host（pid / session / log / APK / devices / voice / notify.json），`cli/daemon-home.test.mjs` 守住 |

### 备注

- 旧命令**没有立即删除**：`cli/ui/deprecate.mjs` 里统一登记，并在提示里写明 0.5.0 移除。这是计划里本来就承诺的「保留一个发布周期」，不是遗留项。
- `memory init` / `memory migrate` / `worker current` / `terminal current` / `project agent` 仍可用，但每次会话都会提示一次新位置。
