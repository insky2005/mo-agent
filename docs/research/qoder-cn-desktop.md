# 预研：Qoder CN（桌面智能工作台）能不能接进 mo-agent

日期：2026-10-18
范围：**Qoder CN 桌面端**（/Applications/Qoder CN.app，com.qodercn.app 0.4.4）。
明确排除：Qoder CN IDE、Qoder CN CLI（CLI 已在 [domestic-agents-hooks.md](domestic-agents-hooks.md) 里评过）。
本机实测环境：macOS，Qoder CN 桌面版 0.4.4（Electron 43），内置 CLI 运行时 1.1.68。

## 0. 结论

**能接，而且比 Claude Code 还省事。** 一句话：桌面版就是「Electron 壳 + Qoder CLI 内核」，我们已经有的一半代码可以直接复用。

| 能力 | 结论 | 依据 |
|---|---|---|
| 观测会话 / 在不在跑 | ✅ 可做，几乎零成本 | transcript 在 `~/.qoder-cn/projects/*/*.jsonl`，格式与 Claude Code 同构 |
| 轮次完成（run.completed） | ✅ 显式 | `assistant.message.stop_reason === "end_turn"`，实测存在 |
| 等待授权 / 等待输入 | ✅ 官方 Hooks | `PermissionRequest` / `Notification` / `Elicitation` 等事件 |
| 手机远程批准 | ✅ 可做（待一次真机验证） | Hook 输出格式与现有 `approvals/hook-cli.mjs` **逐字一致** |
| 手机发指令 / 中断（control） | ❌ 没有公开面 | 桌面端无 prompt/cancel API；本地 57840 端口要 token，属私有接口 |

建议：**P0 只做「观测 + 通知 + 远程批准」，control 留空**（与 Claude Code 同一定位）。
不要为了控制去碰本地私有端口。

## 1. 先厘清：这里的「Qoder CN」指哪个产品

Qoder CN 是个产品家族，容易混：

| 产品 | 形态 | 是不是本文对象 |
|---|---|---|
| Qoder CN IDE | 独立 IDE / JetBrains / VS Code 插件 | ❌ |
| **Qoder CN** | **桌面端「智能工作台」**，源自 IDE 的 Quest 模式，已独立成产品 | ✅ |
| Qoder CN CLI | 终端 `qodercn` | ❌ |
| QoderWork CN | 面向日常办公的桌面应用 | ❌ |
| QoderWake CN | 岗位级 7×24 数字员工 | ❌ |

官方定义见 <https://docs.qoder.cn/qoder/overview>：「New Qoder 源自 Qoder IDE 的 Quest 模式，现在已发展为独立的桌面端产品」。
本机痕迹：`~/Library/Application Support/com.qodercn.app.stable/`、`~/.qoder-cn/`。

## 2. 关键事实：桌面端是 CLI 内核

这不是猜的，是三条实测证据：

1. **运行时日志**：`.../logs/<session>/qodercli/qoder-agent-sdk.log` 里 `[WorkerTransport] Args: --print --output-format stream-json ...`，worker 就是 `qodercn` 的 headless 协议；
2. **transcript 里的 entrypoint**：桌面任务的 user 条目带 `"entrypoint":"cli"`、`"version":"1.1.66"`；
3. **进程**：桌面主进程之外还有一个 Electron utility 子进程（`--utility-sub-type=node.mojom.NodeService`），CLI 运行在它里面；被拉起时也可能出现独立的 `qoderclicn`。

所以：**桌面端的 transcript、hooks、settings 全部走 CLI 那一套**，我们要适配的其实是这套内核，只是把「谁在前面」从终端换成桌面。

## 3. 数据面（本机实测）

### 3.1 transcript —— 首选观测源

```
~/.qoder-cn/projects/<project-slug>/<sessionId>.jsonl
~/.qoder-cn/projects/<project-slug>/<sessionId>/state.json
```

实测某会话（`9caae06c-…`）的条目类型分布：

```
workspace-directories 10   runtime-config 15   worktree-state 5
user 178   attachment 38   active-leaf 376   assistant 325
file-history-snapshot 16   last-prompt 9   system 1
```

assistant 的 `stop_reason` 只有三种：`end_turn`（9 次）、`tool_use`（158 次）、`null`（流式中间态）。
content block：`thinking` / `text` / `tool_use`。
工具结果同样写成 `type:"user"` + `content:[{type:"tool_result"}]`。

**结论：与 `adapters/claude-code.mjs` 的假设完全一致**，包括：
- `userText()` 排除 tool_result 的逻辑；
- `assistantText()` 取 text block；
- `deriveStatus()` 用 `end_turn` / `tool_use` / 文件新鲜度判 working/idle；
- `last-prompt` 元数据行存在（39 个 transcript 里 32 个有）；`permission-mode` **没有**独立条目，权限模式在 user 条目的 `permissionMode` 字段上。

**差异点**：Qoder 没有 `ai-title` 条目（39 个 transcript 实测 0 个），标题要退回「第一问」或从 SQLite 读；
权限模式的取法也要改（读 user 条目的 `permissionMode`，不是等 `permission-mode` 行）。

### 3.2 SQLite —— 标题 / 状态 / 历史（可选增强）

```
~/Library/Application Support/com.qodercn.app.stable/main.sqlite   （97MB，WAL）
```

相关表：

| 表 | 内容 | 用途 |
|---|---|---|
| `chat_sessions` | `session_id, title, cwd, product_mode, permission_mode, archived, updated_at, workspace_id` | 稳定标题、归档过滤、permission 模式 |
| `chat_session_messages` | `payload_json`（role/text/tools/timestamp）、`status` | 历史轮次（实测 1425 completed / 10 failed / 10 interrupted） |
| `chat_session_turn_states` | `status ∈ starting/running/waiting-user/completed/failed/canceled/interrupted` | 状态词表几乎就是 `core/status.mjs`，但**本机为空**，别当 P0 依赖 |
| `chat-session-turn-payload-buffer.sqlite` | 流式缓冲 | 不建议碰 |

只读 + WAL 打开即可，实测不打扰桌面端。**但表结构会随版本迁移，P0 不要依赖。**

### 3.3 进程 / 端口

- 进程名：`Qoder CN`（主进程 / Helper）；另外可能拉起 `qoderclicn`。process 匹配建议两个都写。
- 本地监听：`127.0.0.1:57840`，任何路径都返回 401，需要应用内 token。
  **这是私有 daemon，不写进适配器。**

### 3.4 日志

`~/Library/Application Support/com.qodercn.app.stable/logs/<ts>-<pid>-<hash>/`
有 `main.log`、`collaboration.log`、`qodercli/qoder-agent-sdk.log`，排障时有用，不适合做事件源。

## 4. Hooks —— 批准路径

### 4.1 官方支持

桌面端文档：<https://docs.qoder.cn/qoder/hooks.md>
- 事件与 CLI 一致：`SessionStart/SessionEnd/Stop/StopFailure/UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/PermissionDenied/Notification/Elicitation/...`
- 处理程序类型：`command` / `http` / `prompt` / `agent`
- 配置：用户级 `settings.json` 的 `hooks` 分组；项目级 `<project>/.qoder/settings.json`、`settings.local.json`
- 设置页「设置 → 钩子」只做展示（读用户 settings.json），**执行在运行时**

### 4.2 配置路径：文档和实现不一致，注意

- 文档写用户级是 `~/.qoder/settings.json`；
- 但 CN 版运行时的用户配置目录是 **`~/.qoder-cn`**（bundle 里 `configDirName: ".qoder-cn"`、`projectConfigDirName: ".qoder"`，worker 环境变量 `QODERCN_CONFIG_DIR=~/.qoder-cn`）；
- 本机两个文件都存在，内容分别像「桌面版」和「CLI/国际版」。

**做法：只写 `~/.qoder-cn/settings.json`。** `~/.qoder` 是 Qoder 国际版 / IDE 的配置目录，不能混写；
落地时已经确认桌面端读的是 `~/.qoder-cn`。

### 4.3 输出格式：和 Claude Code 一样

从内置 CLI 1.1.68 里能读到 `PermissionRequest` 的输出 schema：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

deny 形态是 `{"behavior":"deny","message":"…","interrupt":false}`；
另有 PreToolUse 风格的 `permissionDecision: "allow" | "deny" | "ask"` 与 `updatedInput`。

**这与 `approvals/hook-cli.mjs` 现在吐出的 JSON 完全一致**（第 124–131 行），
也就是说 hook 脚本一行不用改，只需要给 profile 声明事件映射。

CLI 里两条消费路径也分别对上了：

- `getDecision()` 读 `hookSpecificOutput.decision` 对象（`behavior: allow / deny`）→ 这是 **PermissionRequest** 走的路径，正是我们现有的输出；
- `permissionDecision: "allow" | "deny" | "ask"` → 这是 **PreToolUse** 走的路径，以后要做「工具级硬拦截」再用。

### 4.4 兜底语义仍然成立

`hook-cli.mjs` 在拿不到手机决定时「不输出任何内容、exit 0」，
桌面端会照常弹它自己的授权框 —— 与 [ADR-0001](../adr/adr-0001-observational-first.md) 一致。

### 4.5 反证：内部任务确实会走 hooks

桌面端为「标题生成 / 回顾生成」等内部任务生成的临时 settings 里明确写了：

```json
{"plugins":{"hotReload":false},"enabledPlugins":{...},"disableAllHooks":true}
```

只有需要**关掉** hooks 的内部任务才会写 `disableAllHooks`，
说明正式会话默认是开着 hooks 的。

## 5. 能力映射（对 `core/contract.mjs`）

| profile 字段 | 取值 | 说明 |
|---|---|---|
| `id` / `label` | `qoder-cn` / `Qoder CN` | |
| `module` / `export` | `./qoder-cn.mjs` / `QoderCnAdapter` | 复用 transcript 适配器 |
| `process.match` | `["(^|/)Qoder CN($|\\s)", "(^|/)qoderclicn?($|\\s)"]` | 桌面主进程 + CLI worker |
| `session` | `{"kind":"jsonl-transcript","root":"~/.qoder-cn/projects","pattern":"*/*.jsonl"}` | |
| `capabilities.observe` | `["process","transcript"]` | 不要 `native-api`（没有） |
| `capabilities.runEnd` | `explicit` | `end_turn` |
| `capabilities.attention` | `hook` | |
| `capabilities.approval` | `allow` | PermissionRequest hook |
| `capabilities.control` | `[]` | 手机不能发指令/中断 |
| `hooks.events` | `{"PermissionRequest":"approval.pending","Notification":"notice"}` | |

已按这份草稿落地（见第 11 节），profile 里 `enabled` 已改为 `true`：

```json
{
  "id": "qoder-cn",
  "label": "Qoder CN",
  "enabled": true,
  "module": "./qoder-cn.mjs",
  "export": "QoderCnAdapter",
  "process": { "match": ["(^|/)Qoder CN($|\\s)", "(^|/)qoderclicn?($|\\s)"] },
  "session": { "kind": "jsonl-transcript", "root": "~/.qoder-cn/projects", "pattern": "*/*.jsonl" },
  "capabilities": {
    "observe": ["process", "transcript"],
    "runEnd": "explicit",
    "attention": "hook",
    "approval": "allow",
    "control": []
  },
  "hooks": {
    "kind": "qoder-cn",
    "settingsFile": "~/.qoder-cn/settings.json",
    "events": { "PermissionRequest": "approval.pending", "Notification": "notice" }
  },
  "approval": {
    "capability": "allow",
    "mechanism": "PermissionRequest hook（decision.behavior，与 Claude Code 同格式）",
    "note": "桌面端会先弹自己的框；hook 不返回决定即 defer"
  }
}
```

## 6. 实现方案（三个改动点，都很小）

1. **抽出 transcript 基类**：`adapters/claude-code.mjs` 里 `"claude-code:"` 前缀写死了 6 处，
   建议抽出 `transcript-adapter.mjs`，构造参数 `{ name, prefix, root, titleResolver }`；
   `qoder-cn.mjs` 只做子类 + 覆盖标题来源。
2. **标题来源**：优先 `chat_sessions.title`（只读 SQLite，失败就静默回退到第一问）；
   `ai-title` 在 Qoder 不存在，不要等它。
3. **hook 配置片段**（写进 `~/.qoder-cn/settings.json`，路径换成本仓库绝对路径）：

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [ { "type": "command", "command": "node /ABS/PATH/mo-agent/approvals/hook-cli.mjs event PermissionRequest qoder-cn" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "command": "node /ABS/PATH/mo-agent/approvals/hook-cli.mjs event Notification qoder-cn" } ] }
    ]
  }
}
```

完成事件**不要**再加 `Stop` hook：transcript 的 `end_turn` 已经负责 `run.completed`，
两路都发会重复通知（`adapters/README.md` 里也是这么规定的）。

## 7. 上线前必须做的一次真机验证（约 10 分钟）

在动手写适配器前，先确认三个「文档没写死」的点：

1. **备份** `~/.qoder-cn/settings.json`，加一个探针 hook（`SessionStart` + `PermissionRequest` + `Stop`），
   command 用 `cat >> /tmp/qoder-hook-probe.jsonl`，把 stdin 原样落盘；
2. 在桌面端新建一个任务，权限选 **询问审批**，让它跑一条需要授权的命令（例如 `touch` 工作区外文件）；
3. 记录：
   - 探针是否触发？触发的是 `~/.qoder-cn` 还是 `~/.qoder` 的配置？
   - stdin 字段是否含 `session_id / transcript_path / tool_name / tool_input / permission_mode`？
   - 返回 `decision.behavior=allow` 后，桌面端是否**不再弹框**、工具直接执行？
   - 返回 `deny` 后，桌面端是否显示拒绝、且 transcript 里有记录？
4. 再跑一次 `auto` 模式，确认高风险命令仍会触发 `PermissionRequest`（低风险本来就不会问，属正常）。

验证通过 = 批准路径闭环；验证不通过（hook 不触发 / 决定不生效）= 退回「只观测 + 只通知」，
profile 的 `approval` 改 `none` 即可，不影响 P0。

## 8. 风险与边界

1. **功能重叠**：桌面端自带「移动端远程控制」（设置 → 集成 → 移动端），能看任务、补指令、处理待确认。
   mo-agent 在这里的差异点是：跨 Agent 统一视图 + 局域网直连 + 耳机/语音，而不是「帮你远程控制 Qoder」。
2. **没有控制面**：不能从手机发 prompt / 中断；UI 会隐藏发送/中断按钮，后端 409，属预期。
3. **auto 模式会降低卡点频率**：桌面默认 `auto`（AI 分类器判断风险），很多操作不弹框；
   `default`（询问审批）才会稳定出 `PermissionRequest`。接入时要在手机卡片上说清当前权限模式。
4. **远程 / Worktree 执行**：SSH 工作区、远程执行时 transcript 可能不在本机，
   `~/.qoder-cn/projects` 只能看到本地会话。
5. **CLI 会话混入**：同一目录也会出现 `qodercn` CLI 的会话（`entrypoint` 区分不了，桌面端也写 `cli`）。
   可选：用 `chat_sessions.session_id` 白名单过滤，或统一显示为 `Qoder CN` 系列。
6. **配置路径漂移**：文档 `~/.qoder` vs 实现 `~/.qoder-cn`；版本升级可能再变，探针脚本要留着。
7. **隐私**：transcript 全文含代码和对话；适配器只发 preview/摘要，详情按需读，与现有 Claude 适配器一致。
8. **重复通知**：Qoder 手机端和 mo-agent 可能同时提醒；建议在 Qoder 设置里关掉移动端推送，或 mo-agent 侧对同一 `sessionId` 去重。

## 9. 结论与建议

- **优先级：高。** 目标用户（国内、阿里系、桌面 Agent 重度用户）覆盖好，接入成本是现有适配器里最低的：
  transcript 复用、hook 输出零改动。
- **不动 `core/`、`host/notify*`、`app/web/`**，按 `adapters/README.md` 的老路走：
  profile + adapter + fixtures 三件套。
- 下一步顺序：
  1. 第 7 节真机验证；
  2. 抽 `transcript-adapter.mjs` 基类（顺带让 Claude 适配器回归测试跑一遍）；
  3. 加 `adapters/profiles/qoder-cn.json` + `adapters/qoder-cn.mjs` + fixtures；
  4. 更新 `contract.test.mjs` 的期望列表、跑能力表生成脚本。

## 10. 参考

- Qoder CN 桌面端总览：<https://docs.qoder.cn/qoder/overview>
- 桌面端 Hooks：<https://docs.qoder.cn/qoder/hooks>
- 桌面端访问权限（询问审批 / 自动审批 / 完全访问）：<https://docs.qoder.cn/qoder/approval-and-sandbox>
- 桌面端移动远程控制：<https://docs.qoder.cn/qoder/remote-control>
- CLI Hooks 参考（事件/退出码/输出）：<https://docs.qoder.cn/cli/hooks-reference>
- CLI 权限与 `PermissionRequest` hook 放行：<https://docs.qoder.cn/cli/permissions>
- CLI 产品族对比：<https://developer.aliyun.com/article/1762182>

## 11. 落地记录（2026-10-19）

已实现：

| 改动 | 文件 |
|---|---|
| 抽出 transcript 基类，Claude / Qoder 共用 | `adapters/transcript-adapter.mjs`、`adapters/claude-code.mjs` |
| 新增 Qoder CN 适配器 | `adapters/qoder-cn.mjs`、`adapters/qoder-cn.test.mjs` |
| 新增 profile（观测 + hook 映射） | `adapters/profiles/qoder-cn.json` |
| 一键配置支持多文件 + `qoder-cn` kind | `host/agent-hooks.mjs`、`host/agent-hooks.test.mjs` |
| /agents 页展示多个配置文件 | `host/pair-http.mjs` |
| 终端快捷入口 | `npm run hooks:qoder-cn`（`package.json`） |
| 手动兜底模板 | `hooks/qoder-cn/settings.snippet.json` |

一键配置的三个入口（同一套逻辑）：

1. 菜单栏托盘 →「一键配置 Agent…」→ 勾选 Qoder CN；
2. 电脑浏览器打开 `http://127.0.0.1:7788/agents`；
3. 终端 `npm run hooks:qoder-cn` 或 `npm run hooks:install`。

只写 `~/.qoder-cn/settings.json`（CN 版运行时实际读的配置）；`~/.qoder/settings.json` 是 Qoder 国际版 / IDE 的，
不去碰。多 settings 文件的写入能力保留在 `host/agent-hooks.mjs` 里备用。

本机验证：

- 用真实 transcript 跑新适配器：31 个会话全部解析出标题 / 状态 / 轮次 / 权限模式；
- `npm test` 252 项通过，`npm run check`、`npm run docs:capabilities:check` 通过；
- `--dry-run` 能正确列出 PermissionRequest / Notification 两条待写 hook。

**仍然待办（唯一未闭环项）**：第 7 节的真机授权验证——在 Qoder CN 桌面端里跑一个需要授权的任务，
确认 `PermissionRequest` 真的触发、返回 `decision.behavior=allow` 后桌面端不再弹框。
在验证通过前，把 Qoder CN 当成「观测 + 通知已可用，远程批准待验证」更稳妥；
万一 hook 不触发，把 profile 的 `capabilities.approval` 改成 `none` 即可，不影响其它能力。
