# cli/ 分层重构清单

状态：待执行　日期：2026-11-01　基线：0.3.0（657 项测试全绿）
关联：[architecture.md §5](../architecture.md)、[ADR-0004](../adr/adr-0004-private-router-runtime.md)、[守卫测试](../../scripts/architecture.test.mjs)

## 0. 为什么要动

architecture.md §5 把目标写成 **core → 应用层 → 接口层 → 用户面**，但物理上"应用层"和"接口层"都挤在 cli/ 里。结果是两件事：

- host 想复用工作台逻辑时，只能在 cli/lib/ 和 cli/commands/ 之间靠自觉选；
- Router 的逻辑住在 host/router/（接口层），于是 cli/commands/setup.mjs 与 doctor.mjs 反过来 import 它——这就是守卫测试里那 6 处 cli → host 的根因。

**要动的不是目录名，而是让"谁能 import 谁"由位置决定，不再靠记性。**

## 1. 判别方法：三个问题

| # | 问题 | 是 | 否 |
|---|---|---|---|
| 1 | 它有 IO 吗（fs / spawn / 网络 / stdout）？ | 不是 core | 见 2 |
| 2 | 它是"给终端看的"吗（argv、文案、补全、进度）？ | **接口层** | 见 3 |
| 3 | 第二个接口会需要它吗（host / 未来的 GUI / 别的入口）？ | **应用层** | 留在接口层 |

纯代码不必都搬去 core/。**什么时候下移？第二个层需要它的那一刻。** 提前下移只会把 core 变成垃圾桶。

## 2. 现状盘点（cli/ 共 54 个文件，约 9.5k 行）

| 层 | 文件 | 约行数 | 判据 |
|---|---|---|---|
| **应用层**（host 可 import） | lib/ 下 project、approvals、config、store、ingest、dispatch、runner、verify、envelope、inbox、knowledge、candidates、watchdog、executors、terminals、session-launch、workers-config、logs、platform、ids、fsx、paths | ~3.6k | 领域逻辑，与终端无关；host 已在用其中 6 个（config / project / store / approvals / paths） |
| **接口层 CLI**（只有二进制用） | mo.mjs、lib/ 下 args、output、help、complete、skill-content、version、commands/*（19 个）、demo/* | ~5.0k | argv、文案、补全、命令编排 |
| **工具层**（给 CLI 自己用，不属于任何一层） | lib/ 下 upgrade、apk、download、host-install | ~0.8k | 维护 CLI 自身 / 下载资产 / 装 host，不是领域 |

## 3. 五个"混在一起"的具体症状

| # | 症状 | 证据 | 修法 |
|---|---|---|---|
| **S1** | 应用层反向依赖接口层 | cli/lib/complete.mjs:11 import 了 ../commands/skill.mjs | 补全表属于接口层：把 complete.mjs 挪到 cli/commands/，或让 skill 提供一个纯数据模块给两边用 |
| **S2** | 工具代码混在应用层 | upgrade（自升级二进制）、apk（下手机 App）、host-install（装 host）、download（公共下载） | 移到 cli/tools/。它们不属于领域，host 永远不会用 |
| **S3** | 接口层之间反向依赖 | commands/setup.mjs 引 host/router/{install,credentials,probe,paths}；commands/doctor.mjs 引 host/router/{paths,fsx} | 见 S4 |
| **S4** | 应用逻辑住在接口层 | host/router/ 整个目录（argv、script、terminal、node、install、credentials、probe、runtimes、manager、paths，约 1.4k 行）本质是"Router 这个应用能力" | 下移到应用层；host 只留"会话注入 + HTTP 薄壳 + 接管扫描" |
| **S5** | 纯逻辑与 IO 混住 | lib/paths、ids、envelope、workers-config、version 是纯函数，其余都是 IO | **不处理**。只在被第二个层需要时，才把纯的那部分下移到 core |

## 4. 分阶段清单

### P0 · 立规则（0.5 天，零行为变化）

| # | 动作 | 验收 |
|---|---|---|
| P0.1 | 守卫测试增加两条：**禁止 cli/lib 引 cli/commands**；**禁止 cli/commands 被 host 引** | 跑 npm test，不加白名单时会红（说明规则真的生效） |
| P0.2 | 修 S1：complete.mjs 归位到接口层 | cli/lib 下不再有任何指向 ../commands 的 import |
| P0.3 | 文档把 cli/lib 标成"应用层"、cli/commands 标成"接口层" | architecture.md 的 cli 行拆成两行 |

**P0 不动任何行为，也不移动 Router。**

### P1 · Router 下移（1–2 天，KNOWN_DEBT 归零）

| # | 从 | 到 | 备注 |
|---|---|---|---|
| P1.1 | host/router/argv.mjs | cli/lib/router-argv.mjs | 纯函数，直接搬 |
| P1.2 | host/router/script.mjs | cli/lib/router-script.mjs | 纯函数 |
| P1.3 | host/router/terminal.mjs | cli/lib/router-terminal.mjs | spawn 终端窗口 |
| P1.4 | host/router/node.mjs | cli/lib/router-node.mjs | Node 版本解析 |
| P1.5 | host/router/runtimes.mjs | cli/lib/router-runtimes.mjs | 版本 pin（必须 JS 模块，不能 JSON） |
| P1.6 | host/router/install.mjs | cli/lib/router-install.mjs | npm 安装 + 自检 + shim 修复 |
| P1.7 | host/router/credentials.mjs | cli/lib/router-credentials.mjs | 0600 落盘 + env 映射 |
| P1.8 | host/router/probe.mjs | cli/lib/router-probe.mjs | 测通 |
| P1.9 | host/router/paths.mjs | cli/lib/router-paths.mjs | dataDir 与 osHome 分离 |
| P1.10 | host/router/fsx.mjs | 并入 cli/lib/fsx.mjs | 已有一半同名函数 |
| P1.11 | host/router/manager.mjs | cli/lib/router-manager.mjs | **hub 变可选**；不再 emit 事件，改为 onSession 回调 |
| P1.12 | — | 新增 host/router-session.mjs | host 侧：start / stop 时注入与移除会话；启动时 adopt() 扫 router.json 与 pid，发现活着的 Router 就接管 |
| P1.13 | host/http.mjs 的 router 路由 | 不变 | 仍调 cli/lib/router-manager |
| P1.14 | cli/commands/setup.mjs、doctor.mjs | 改成 import cli/lib/router-* | 反向依赖消失 |
| P1.15 | KNOWN_DEBT | 删空 | 守卫测试从"白名单 + 债"变成纯白名单 |

**P1 的行为收益**：mo router 不再要求 host 在场（host 起来后再接管控制面）；E_DAEMON_DOWN 从这条路径消失。

**顺序要求**：先 P1.1–P1.10（纯搬运，每搬几个就跑一次测试），再 P1.11（改 manager 签名），最后 P1.12 / P1.14 / P1.15。**不要一次性搬完再跑测试。**

### P2 · 物理改名（可选，2–3 天）

| # | 从 | 到 | 代价 |
|---|---|---|---|
| P2.1 | cli/lib/（应用层） | workbench/（或 app-core/） | **121 处 import、32 个文件**要改；package.json 的 glob 与 check 清单要同步 |
| P2.2 | cli/lib 下 upgrade、apk、download、host-install | cli/tools/ | 新增子目录，测试 glob 要加一条 |
| P2.3 | cli/lib 下 args、output、help、complete | cli/ | 纯移动 |

**我的建议：P2 先不做。** 121 处 import 换一个更准的名字，收益只是"看目录就知道层级"，成本是一次大范围机械改动加一次全量回归。等 P1 做完、守卫测试变成纯白名单之后再看——那时 cli/lib 已经只有一个含义了。

### P3 · 暂不做

- host 内部再拆 service 与 interface：当前 47 个文件、11k 行，职责还清楚，拆了反而多一层跳转；
- 把纯函数全部下移 core：见 §1 的判据，只在被第二层需要时下移；
- monorepo 分包：规模不够，构建成本会超过收益。

## 5. 每个阶段的验收

| 阶段 | 验收（都能自动跑） |
|---|---|
| P0 | npm test 绿；scripts/architecture.test.mjs 新增两条断言；cli/lib 下不再有指向 commands 的 import |
| P1 | KNOWN_DEBT 为空且测试全绿；mo router 在 host 停着时也能起（人工验一次）；mo doctor 仍能报 host 状态 |
| P2 | 全量测试绿；mo --version、mo help、补全、mo router 各跑一次 |

## 6. 收益与代价（一句话）

- **P0**：把"靠自觉"换成"会失败"，半天。
- **P1**：还清唯一的架构债，顺带让 Router 脱离 host；一天半。
- **P2**：只是名字更准，两天以上且纯机械。除非名字真的误导了新人，否则不做。

