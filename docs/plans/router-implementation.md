# Router 实现计划（任务书）

状态：**待执行**　日期：2026-11-01　基线：v0.3.0，585 项测试全绿
路径说明：本文档保留任务书原貌；其中 `host/router/*` 后来按 [cli 分层重构清单](cli-layer-split.md) 迁到 `cli/lib/router-*.mjs`（应用层），host 只留 `router-session.mjs`。
设计：[ADR-0004](../adr/adr-0004-private-router-runtime.md)、[spec/router.md](../spec/router.md)
工作量估计：单人约 **9–10 人日**，四个阶段，每个阶段结束时系统都可测、可停、可回退。

---

## 0. 排序原则

按**风险从低到高**推进，而不是按文档顺序：

1. **纯逻辑先做**——能单测、不需要进程、不需要网络、不碰用户环境；
2. **IO 其次**——安装、凭据、落盘，有失败路径但可 mock；
3. **进程最后**——spawn、pid、健康检查、崩溃恢复，最难测且最容易留下脏状态；
4. **界面与监控收尾**——没有它们系统也能跑，属于产品化。

每个阶段都必须满足：`npm test` 全绿、Worker 平面行为零变化。

## 1. 阶段总览

| 阶段 | 内容 | 人日 | 完成标志 |
|---|---|---|---|
| **P0 结构地基** | `role` 字段、契约分角色、启动参数构造为纯函数 | 1.5 | 单测覆盖，不起任何进程 |
| **P1 垂直切片** | 临时环境变量凭据 + spawn + 注入 hub + 三个命令 | 2 | **能在 workbench 跟 Router 说话，并派出一张卡** |
| **P2 产品化** | 私有安装/版本化、凭据与引导、单实例与健康、监控卡、doctor | 3.5 | 用户第一次 `mo router start` 走引导，无需手改环境变量 |
| **P3 补能力** | `note_write`、`memory.rejected`、配额不可变量 | 2 | §5.3 / §5.5 的缺口补齐 |
| **P4 下一期** | 无窗口形态、mo 自建界面、DSH runtime、Trigger 驱动 | — | 不在本任务书范围 |

**P1 结束就有真实价值**，P2 只是把它变成用户能自己装的东西。如果时间紧，P0+P1 可以先跑起来用。

---

## 2. P0 · 结构地基（1.5 人日）

不动进程、不联网、不碰 `~/.pi`。全部可单测。

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| P0.1 | 会话身份增加 `role` | `core/contract.mjs`、`core/hub.mjs` | 常量 `SESSION_ROLE = {ROUTER, WORKER, UNKNOWN}`；`normalize` 保留既有 `role`（不被后续 upsert 覆盖成 unknown）；`list()` 支持按 role 过滤 |
| P0.2 | 契约分角色渲染 | `core/manager/contract.mjs` | `render({ role: "router" })` 产出 spec §8 的 6 条；`render()` 默认仍是 worker 版，**现有生成物一字不变**（`npm run check` 必须过） |
| P0.3 | Pi 启动参数构造（纯函数） | 新增 `cli/lib/router-argv.mjs` | `buildPiArgv({ runtimeBin, cwd, contractPath, sessionId, tools })` → `{ argv, env }`；断言：含 `--tools`、含 `read,grep,find,ls,mcp__mo__*`、**不含** `bash/edit/write`、env 里 `PI_CODING_AGENT_DIR` 指向私有目录 |
| P0.4 | 运行时能力准入（纯函数） | 新增 `core/router.mjs`（准入判定） | `checkRuntime(capabilities)` → `{ ok, reason }`；`toolRestriction:"none"` 必须返回拒绝且码为 `E_ROUTER_RUNTIME_UNSUPPORTED` |
| P0.5 | 错误码登记 | `core/errors.mjs` 或就近 | spec §4.3 的 8 个码都有定义、有中文提示、有下一步 hint |

**为什么 P0.3 先做**：它是整个"Router 没有手"承诺的唯一落地点，必须是纯函数 + 单测。写成一段字符串拼接塞在 spawn 里，就没有任何东西能保证它一直对。

## 3. P1 · 垂直切片（2 人日）

目标：**证明链路**。跳过安装与引导 UI，凭据临时从环境变量读。

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| P1.1 | Router 会话注入 hub | 新增 `host/router/session.mjs` | spawn 后 `hub.emit(session.upsert, { id:"mo-router", role:"router", agent:"pi", capabilities:{prompt:true,cancel:true} })`；与 Pi adapter 不产生重复条目 |
| P1.2 | 进程启动与停止 | 同上 + `host/router/runner.mjs` | 终端窗口形态（见 §6 R1）；pid 落 `router.pid`；stop 先 SIGTERM 后 SIGKILL |
| P1.3 | 凭据旁路 | 新增 `host/router/credentials.mjs`（只做读 env → 映射） | 从 `DEEPSEEK_API_KEY` 等环境变量取，映射表集中一处；**不写任何文件** |
| P1.4 | 三个命令 | 新增 `cli/commands/router.mjs`、`cli/mo.mjs`、`cli/lib/help.mjs` | `mo router start|stop|status`；`start` 走 `POST /local/router/start`（**生命周期归 host**，见 §6 R2） |
| P1.5 | 本机接口 | `host/http.mjs` | `/local/router/status|start|stop`，令牌校验同现有 `/local/*`，局域网 403 |

**P1 验收（人工走一遍）**：

1. `DEEPSEEK_API_KEY=... mo router start` → 终端窗口起来，界面在 workbench；
2. 对它说"帮我把 mo-agent 里那个 note_write 的设计落成一张卡" → 它调 `task_create`（不带路径、带 `project`）；
3. `mo task list` 能看到这张 draft 卡；
4. 让它 `bash` → 报工具不存在；
5. 手机关掉 Wi-Fi 用钉钉说一句 → 消息进 Router；
6. `mo router status` 显示 pid、模型、role；
7. `mo router stop` → 进程没了，hub 里会话消失。

**这一步跑通，架构就验证完了。**

## 4. P2 · 产品化（3.5 人日）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| P2.1 | 私有安装与版本化 | `host/router/install.mjs` | 下载 → sha256 → 临时目录 → 同目录 rename；`routers/<id>/<version>/`；保留上一版；失败不留半个安装 |
| P2.2 | 版本 pin | `host/router/runtimes.mjs` | 不是 latest；`mo router runtime prune` 清旧版。**必须是 JS 模块**：单文件二进制只内联 JS，读外部 JSON 会 ENOENT |
| P2.3 | 凭据落盘 | `host/router/credentials.mjs` | `~/.mo-agent/router/credentials.json` `0600`（抄 `host/dingtalk-setup.mjs:65` 的 tmp+chmod+rename）；日志与界面只显后 4 位 |
| P2.4 | 引导与测通 | 新增 `host/router/setup.mjs` | 状态机 R2–R4；**测通必做**（真实发一条短消息）；失败给原始错误 |
| P2.5 | 设置页第 6 个 tab | `host/settings-page.mjs` | `{ id:"router", label:"指挥台", hint:"你的主 Agent：拆任务、派单、盯进度" }`；含「用本机已有的」但不静默复用 |
| P2.6 | 单实例与健康 | `host/router/runner.mjs` | 第二个 start 是 attach；重启 3 次仍失败停在 `E_ROUTER_UNHEALTHY` 并告警，**不无限重启**（否则在错凭据上烧钱） |
| P2.7 | 监控卡 | `app/web`、`host/monitor-http.mjs` | 「指挥台」单独一张卡：状态 / 模型 / 本月用量 / 一键停止；runtime+version 默认折叠 |
| P2.8 | doctor | `cli/commands/doctor.mjs` | 检查 runtime 版本、凭据是否存在、Router 是否在跑；缺失给可执行下一步 |

## 5. P3 · 补能力（2 人日）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| P3.1 | 笔记纯逻辑 | 新增 `core/notes.mjs` | slug 生成与校验（`[a-z0-9-]`、≤64）、64KB 上限、同日同 slug 序号推导；**不碰 fs** |
| P3.2 | 笔记落盘 | 新增 `cli/lib/notes.mjs` + `cli/commands/note.mjs` | `mo note write --json`；落 `~/.mo-agent/notes/`；append-only；记 `note.written` 账本 |
| P3.3 | 暴露给 Router | `core/manager/contract.mjs` `TOOLS` + `cli/commands/mcp.mjs` 映射 | `note_write` 出现在 `tools/list`；调一次真的落文件；`npm run docs:capabilities` 与 `gen-skill --check` 同步更新 |
| P3.4 | 被拒候选留账 | `cli/lib/candidates.mjs` | reject 时记 `memory.rejected`；Router 再提同一条能被提示"已被拒过" |
| P3.5 | 配额变成不变量 | `core/manager/contract.mjs` 的 `RULES` → 校验代码 | 一次对话最多 2 条提案由 core 计数拒绝，不靠文案（研究 §7.1 的教训：文案约束会漏） |

## 6. 两个必须先定的点（写计划时才暴露的）

### R1 · v1 的形态：终端窗口，不是后台 detached

spec §10 现在写的是 `detached` + `start.log`。但 **TUI 需要 tty**：detached 进程没有终端，Pi 的界面根本没地方画。三选一：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐 v1）** | `mo router start` 开一个终端窗口跑 Router（复用 `cli/lib/terminals.mjs` + `session-launch.mjs`） | 关窗口就死；"常驻"取决于窗口 |
| B | tmux 承载，detached 但可 attach | 引入 tmux 依赖 |
| C | `--mode rpc` 无 TUI（本来就无窗口） | v1 没有界面，等于跳到 P4 |

**建议 A**，并据此修订 spec §10：Router 是"终端窗口形态"，`start.log` 改为可选。B/C 留给 P4。

### R2 · 生命周期归 host，不归 CLI

Router 必须由 **host** spawn 并持有 pid，CLI 只发 HTTP 请求。三个理由：

1. host 才是常驻的，桌面 App 重启后能自动把 Router 拉回来；
2. 会话注入 hub 是 host 的职责，CLI 进程退出后没人持有；
3. 否则 `mo router start` 与桌面 App 会各起一个，pid 文件互相覆盖（`daemon.mjs` 已经踩过这个坑，注释里写着"再起一个会撞端口而且健康检查会误报"）。

## 7. 风险登记

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| R3 | 空配置目录缺 `bin/fd`、`bin/rg` | `grep/find` 可能降级或触发下载 | 实现前先做 spec §15 的 A2 验证；必要时在安装步骤里一并准备 |
| R4 | Pi CLI 契约漂移（`--tools` 语义） | 白名单失效 → Router 拿到手 | 版本 pin + `mo doctor` 检查 + P0.3 的单测断言固定期望值 |
| R5 | 引导时的测通会产生真实计费调用 | 成本极小但要有说明 | 测通只用一条极短消息，界面上注明 |
| R6 | Router 与 Worker 抢端口/锁 | host 已有单实例锁 | 不加新锁，复用 `desktop.lock` 同款模式 |
| R7 | 用户在终端里手动跑 `pi` 干扰 | Pi adapter 可能把用户会话当成 Router | 身份靠 `role` 与固定 `--session-id`，不靠 cwd 猜 |

## 8. 明确不做（本任务书范围外）

- Trigger / 事件自动驱动 Router（那是事件平面那一期）；
- 多 Router 实例；
- 自建对话界面；
- DSH runtime 实现；
- 不改 `adapters/`、不改 Worker 平面任何行为。

## 9. 建议的开工顺序（一句话）

**P0.3 → P0.1 → P0.2 → P0.4/P0.5 → P1 → 停一下复核 → P2 → P3。**

先写 `buildPiArgv` 的单测：它是"Router 没有手"唯一可验证的地方，也是后面所有阶段的地基。
