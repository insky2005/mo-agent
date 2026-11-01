# 架构总览

状态：与当前代码（0.2.0）一致　日期：2026-10-23　关联：[ADR-0001](adr/adr-0001-observational-first.md)、[ADR-0003](adr/adr-0003-event-contract.md)、[事件契约](spec/event-contract.md)

## 1. 这是什么

Mo Agent 是 macOS 上的**常驻 Agent 监理**：观察本机各个 Agent 的会话，归一成一套领域事件，在你真正需要决定的那一刻（授权、提问、完成、失败）把消息递到你面前，并支持远程批准与指令。

它**不托管 Agent、不改变 Agent 的运行方式**。这一条决定了整个架构：观测优先，接入靠 adapter，而不是靠改造对方。

## 2. 分层

```
   厂商原始输入                     用户面
   transcript / RPC / 进程表 / hook     手机 · 菜单栏 · 管理页 · 耳机
            │                                   ▲
            ▼                                   │
   ┌─────────────────┐   ┌──────────┐   ┌──────────────┐
   │    adapters     │──▶│   core   │──▶│     host     │
   │  翻译成领域事件  │   │ 归约·分发 │   │ HTTP/推送/进程 │
   └─────────────────┘   └──────────┘   └──────────────┘
            ▲                  ▲                │
            │                  │                ▼
   ┌─────────────────┐         │        ┌──────────────┐
   │   approvals     │─────────┘        │ app/web      │
   │ hook → 决策 broker │                │ desktop 壳   │
   └─────────────────┘                  └──────────────┘
```

数据自上而下单向流动，只有 `approvals` 是一条反向通道（Agent 卡住时回调进来）。

## 3. 目录职责

| 目录 | 职责 | 边界 |
|---|---|---|
| `adapters/` | **观测层**。把每家 Agent 的原始状态翻译成统一事件；`profiles/*.json` 声明能力（观测方式、runEnd、批准、控制、hooks） | 只陈述事实，不决定通知文案 |
| `core/` | **领域核心，纯逻辑**。事件词汇表、状态归约、Hub 分发、通知策略、内存存储 | **不碰文件、不发网络、不起进程** |
| `host/` | **服务与进程宿主**。HTTP、SSE、鉴权、配对、决策、hooks 写入、钉钉、推送、语音 | 唯一的 IO 层 |
| `approvals/` | **审批挂接点**。被 Agent 调用的 hook CLI、决策 broker、厂商事件名映射 | 不直接推送 |
| `app/web/` | 管理页、监控页、审批页、PWA | 只通过 host 的 HTTP 访问 |
| `app/android/` | Capacitor 原生工程 | 复用 web 资源 |
| `desktop/` | ElectroBun 桌面壳：菜单栏、单实例、拉起 host、打包 | 不含业务逻辑 |
| `scripts/` | 构建、安装、生成、e2e | — |
| `hooks/` | 三家 Agent 的 `settings.snippet.json` 模板 | 只是模板，由 host 写入真实配置 |

## 4. 一次事件的生命周期

```
1. adapter 观察到一个事实
   → session.upsert / run.completed / pending.approval / pending.question
2. core/hub 归约状态并分发（SSE 只发 event: message）
3. core/notify 查表决定"这算不算需要打扰人"（NOTIFY_POLICY）
4. host 按通道投递：HMS 推送 / 钉钉 / webhook / 语音
5. app/web 与手机按 type 分发渲染
6. 人的决定从 approvals 反向进入
   → hook-cli → broker → decisions → core → 回到 Agent
```

关键规则（详见 [事件契约](spec/event-contract.md)）：**适配器不发通知，状态语义固定，一轮结束先 `session.upsert` 再 `run.*`。**

## 5. 依赖方向

三层：**core（纯逻辑）→ cli（应用内核，文件即状态，可自我闭环）→ host（服务外壳）**。

| 允许 | 禁止 |
|---|---|
| `cli → core` | `cli → host`（**CLI 必须能独立运行**，host 是它的上层） |
| `host → cli / core / adapters / approvals` | `core → cli / host`（core 不做 IO） |
| `adapters → core` | `adapters → host`（观测层不投递） |
| `approvals → core` | `app/web → core`（前端不直连领域层） |
| `app/web → host (HTTP)` | `host → desktop` |
| `desktop → host (子进程)` | |

**host 只负责"长期在线 + 外部事件源 + UI 数据面"**：适配器观测、手机/钉钉/语音信道、推送、监控页。除此之外的一切——建卡、批准、派单、回执、账本、Router——都应该在 `cli/` 里闭环，不要求 host 在场。

判定方法：**如果一条命令在没有 host 的情况下跑不通，先问"它真的需要长期在线或外部信道吗"**；不需要就是分层错了。

已知的待还债务（本表是目标，不是现状）：

| 位置 | 反向依赖 | 还法 |
|---|---|---|
| `cli/commands/setup.mjs`、`cli/commands/doctor.mjs` | 引了 `host/router/*` | Router 的实现（argv / 安装 / 凭据 / 生命周期）下移到 `cli/lib/router-*.mjs`，host 只保留 HTTP 薄壳与会话注入 |

## 6. 扩展一个 Agent

新增 Agent **不需要改 core / notify / 手机端**：

1. `adapters/profiles/<agent>.json`：声明能力（以 `_template.json` 为底）；
2. `adapters/<agent>.mjs`：把原始状态映射成规范事件；
3. fixtures + 契约测试；
4. `npm run docs:capabilities` 重新生成能力表。

细节见 [adapters/README.md](../adapters/README.md)。

## 7. 运行时形态

```
桌面端：Mo Agent.app → 菜单栏 → 拉起 host/index.mjs（常驻，无窗口）
纯 CLI：node host/index.mjs（或 launchd）
手机：经本机 HTTP + 配对令牌访问，不暴露到局域网
```

单实例由 `~/.mo-agent/desktop.lock` 保证。用户数据在 `~/.mo-agent/`，程序产物在 `~/Library/Application Support/mo-agent/runtime/`。

## 8. 构建与验证

```bash
npm test                      # core / host / adapters / approvals 单测
npm run check                 # 语法检查 + 能力表时效
npm run docs:capabilities     # 重新生成 docs/reference/capabilities.md
bash scripts/build-desktop.sh # 打桌面端
```

## 9. 新增代码该放哪

| 你要加的东西 | 放哪 | 判定 |
|---|---|---|
| 解析某家 Agent 的日志 | `adapters/` | 只读外部数据 |
| 新的通知/审批规则 | `core/` | 纯决策 |
| 新的 HTTP 接口 / 推送通道 / 子进程 | `host/` | 有 IO |
| 被 Agent 回调的入口 | `approvals/` | 由外部进程触发 |
| 界面 | `app/web/` | 只能走 HTTP |
| 打包/安装 | `scripts/`、`desktop/` | — |

### workbench（P0 已实现，P1+ 规划中）

设计见 [spec/workbench-flow.md](spec/workbench-flow.md)，使用见 [cli/README.md](../cli/README.md)。

| 模块 | 位置 | 状态 |
|---|---|---|
| 状态机、卡、回执、账本事件 | `core/tasks/` | ✅ P0 |
| 项目认领、注册表 | `cli/lib/project.mjs` | ✅ P0（P1 迁到 `core/projects.mjs` + host） |
| 派单执行、回执裁决 | `cli/lib/{dispatch,runner,ingest}.mjs` | ✅ P0 |
| CLI | `cli/mo.mjs` | ✅ P0 |
| 账本落盘、检索 | `cli/lib/store.mjs`、`core/memory.mjs` | 落盘 ✅ / 检索 P3 |
| MCP 端点、守护进程派单 | `host/mcp-http.mjs`、`host/runner/` | P1 |
| 模板与 schema 文件 | `templates/`、`schemas/` | 暂缓（CLI 内联生成） |

**必须遵守同一条边界**：`core/tasks/*` 不 import `host/*`，也不 import `cli/*`。
P0 把 IO 全部放在 `cli/`，P1 起由 `host/` 复用同一套 `core/`。