# 预研：Claude 桌面版能不能接进 mo-agent

日期：2026-10-19
范围：**Claude 桌面 GUI**（`/Applications/Claude.app`，本机版本 **2.31226.1**，Electron 44.4.3，内置 Claude Code **2.1.295**）。
明确排除：Claude Code CLI、Claude Code URL Handler、claude.ai 网页版。
本机环境：macOS arm64；桌面端部署模式为 `3p`，因此实际用户数据在 `~/Library/Application Support/Claude-3p`，而不是 `~/Library/Application Support/Claude`。

## 0. 结论

**能接，但必须先把“Claude 桌面版”拆成三个面，不能当成一个 Agent 看。**

| 桌面端的面 | 本质 | 观测 | 完成判定 | 远程批准 | 建议 |
|---|---|---|---|---|---|
| **Chat**（普通对话） | 服务端会话 + Electron 壳 | 只能看进程 | ❌ | ❌ | 不接 |
| **Code**（Code 标签页，CCD） | 内嵌 Claude Code，读写用户的 `~/.claude` | ✅ transcript | ✅ `end_turn` | ⚠️ 大概率可复用现有 hook，待一次实测 | **P0 优先验证，可能零成本** |
| **Cowork / local agent** | 内嵌 Claude Code + 每会话独立 `CLAUDE_CONFIG_DIR` + 本地 VM/沙箱 | ✅ transcript | ✅ `end_turn` | ❌ 用户级 hook 不生效 | **P0 只做观测 + 通知** |

一句话：

> **Code 面是“Claude Code 换了个 GUI”，现有接入大概率直接吃得到；Cowork 面是“另一个隔离配置的 Claude Code”，能看不能批；Chat 面没有可用的本地会话数据。**

因此推荐落地顺序：

1. **先验证 Code 面是否已被现有 `claude-code` 适配器覆盖**（最省事，可能不需要新代码）。
2. **为 Cowork 面新增一个只读适配器**，复用 transcript 解析，补上路径发现、会话元数据、实时状态。
3. **远程批准只对 Code 面承诺**；Cowork 面在 Anthropic 暴露配置入口前，不做“远程放行”的承诺。

## 1. 桌面版到底是什么

### 1.1 三个面

| 面 | 入口 | 运行位置 | 是否有本地 Claude Code 子进程 |
|---|---|---|---|
| Chat | 主对话页 | 远端 | ❌ |
| Code | Code 标签页 / 项目会话 | 本机 | ✅ |
| Cowork | Cowork 任务 / local agent | 本机（轻量 Linux VM 或 host loop） | ✅ |

桌面端不是“一个模型客户端”，而是 **Electron 壳 + 多个本地 Agent 运行时**。它会把 Claude Code 的 CLI 二进制下载到自己的数据目录里运行：

```
~/Library/Application Support/Claude[-3p]/claude-code/2.1.295/<hash>/claude.app/Contents/MacOS/claude
```

本机实测到的 Cowork 子进程命令行（截取关键参数）：

```
claude --output-format stream-json --verbose --input-format stream-json \
  --permission-prompt-tool=stdio \
  --setting-sources=user \
  --permission-mode=default \
  --settings {...} \
  --managed-settings {...}
```

这组参数说明三件事：

- 它就是 Claude Code；
- 它把权限提示通过 stdio 交给桌面端，而不是弹终端对话框；
- 它只加载 `user` 这一层 settings（对 Cowork 而言，这个 `user` 指向会话自己的 `.claude`，见 §4.1）。

### 1.2 为什么本机有两个数据目录

桌面端支持标准部署和第三方部署（3p）：

- 标准：`~/Library/Application Support/Claude`
- 3p：`~/Library/Application Support/Claude-3p`

适配器不能硬编码其中一个，必须按 `Claude*` 发现，并以实际存在的目录为准。

## 2. 本机实测到的数据布局

### 2.1 Code 面

```
~/Library/Application Support/Claude[-3p]/
  claude-code-sessions/
    <accountUuid>/
      <orgUuid>/
        <sessionId>/
        scheduled-tasks.json
```

本次没有创建 Code 会话，所以只看到账户/组织级目录；Code 会话的 transcript 位置需要一次实测确认（见 §9）。从代码路径看，Code 面使用默认的 `~/.claude`，因此 transcript 很可能仍在：

```
~/.claude/projects/<slug>/<cliSessionId>.jsonl
```

如果成立，**现有 `adapters/claude-code.mjs` 已经能观测 Code 面**，只是 UI 上会显示成 “Claude Code”。

### 2.2 Cowork / local agent 面

本机实测（2026-10-19 12:57 创建的一个 Cowork 会话）：

```
~/Library/Application Support/Claude-3p/
  local-agent-mode-sessions/
    ec5ddaae/                 # accountId 前 8 位
      00000000/               # orgId 前 8 位
        local_10571c1f-60a6-4aeb-9be7-254adc482a13.json   # 会话记录
        10571c1f/             # sessionId 前 8 位
          .claude/
            projects/
              session/
                264b9929-3134-493e-a2c4-65866a2bf322.jsonl # transcript
            sessions/
              61172.json      # 实时状态（pid / status / socket）
          audit.jsonl
          outputs/
          uploads/
```

会话记录 `local_*.json` 的关键字段：

```json
{
  "sessionId": "local_10571c1f-60a6-4aeb-9be7-254adc482a13",
  "cliSessionId": "264b9929-3134-493e-a2c4-65866a2bf322",
  "cwd": ".../10571c1f/outputs",
  "createdAt": 1792385848174,
  "lastActivityAt": 1792385850748,
  "model": "claude-sonnet-4-5",
  "isArchived": false,
  "title": "Hello greeting",
  "vmProcessName": "dreamy-cool-einstein",
  "hostLoopMode": true,
  "initialMessage": "hello"
}
```

transcript 是 **标准 Claude Code JSONL**，实测字段：

```json
{"type":"user","message":{"role":"user","content":"hello"},"uuid":"...","timestamp":"...","entrypoint":"local-agent","cwd":"/private/var/empty","sessionId":"264b9929-..."}
{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[...]},"uuid":"...","timestamp":"..."}
```

也就是说：

- **解析层可以直接复用 `adapters/transcript-adapter.mjs`**；
- 不能复用的是“怎么找到文件”和“会话元数据/身份”。

### 2.3 实时状态文件

每个运行中的 Claude Code 会话会写：

```
<sessionDir>/.claude/sessions/<pid>.json
```

本机样本：

```json
{
  "pid": 61172,
  "sessionId": "264b9929-3134-493e-a2c4-65866a2bf322",
  "cwd": "/private/var/empty",
  "version": "2.1.295",
  "entrypoint": "local-agent",
  "kind": "interactive",
  "status": "idle",
  "updatedAt": 1792385850747
}
```

这是比 transcript mtime 更直接的“在不在跑”信号，可作状态提示；但它是内部格式，必须 fail-soft，不能当作唯一真相。

### 2.4 等待输入 / 授权

代码里存在 `waiting-input/` 持久化目录（每个会话目录下），用于应用重启后恢复等待中的输入。本机这次会话没有触发 `AskUserQuestion`，所以未观察到实际文件。

它可能成为“等待回答”的补充信号，但不能替代 hook：**它表示“应用认为会话在等人”，不表示“这次工具调用可以被远程放行”。**

## 3. 能力矩阵

| 能力 | Code 面 | Cowork 面 | Chat 面 |
|---|---|---|---|
| 发现进程 | ✅ | ✅ | ✅ |
| 发现会话 | ✅ transcript | ✅ transcript + 记录 | ❌ |
| 区分“在跑 / 空闲” | ✅ `status` / transcript | ✅ `status` / transcript | ❌ |
| 判定一轮完成 | ✅ `stop_reason === "end_turn"` | ✅ 同左 | ❌ |
| 通知“等你授权” | ✅ `PermissionRequest` hook（待实测） | ❌ 用户级 hook 不加载 | ❌ |
| 手机远程批准 | ⚠️ 待实测 | ❌ | ❌ |
| 手机发指令 / 中断 | ❌ 无公开接口 | ❌ 无公开接口 | ❌ |
| 历史轮次 / 会话标题 | ✅ 记录 + transcript | ✅ 记录 + transcript | ❌ |

## 4. 四个决定性发现

### 4.1 Code 和 Cowork 不是同一条配置链路

Code 面在启动会话时使用：

```js
settingSources: ["user", "project", "local"]
```

并且没有在 `buildSessionEnv` 里看到对 `CLAUDE_CONFIG_DIR` 的覆盖。也就是说，Code 面读的是用户默认的 `~/.claude`，**现有 mo-agent 写入的 `~/.claude/settings.json` hook 会生效**。

Cowork 面在启动会话时使用：

```js
settingSources: ["user"],
env: {
  CLAUDE_CONFIG_DIR: <sessionDir>/.claude,
  CLAUDE_CODE_ENTRYPOINT: "local-agent",
  ...
}
```

它把 `CLAUDE_CONFIG_DIR` 指向每个会话自己的 `.claude`。因此这里的 `user` 是：

```
<sessionDir>/.claude/settings.json
```

不是：

```
~/.claude/settings.json
```

本机该会话的 `.claude` 下只有 `.claude.json`、`projects`、`sessions`、`backups`、空的 `seed-admin`，**没有 `settings.json`**。

结论：

> **Cowork 面不会加载用户全局的 Claude Code hooks。** 现有 `PermissionRequest` hook 对它无效；除非把 hook 注入每个新会话的 `.claude/settings.json`，而那是应用管理的内部目录，不适合作为长期方案。

### 4.2 桌面端的授权卡是应用自己的，不是 CLI 的

桌面端用 `--permission-prompt-tool=stdio` 把权限请求交给主进程，主进程里的 `handleToolPermission` 会：

1. 读会话的权限模式、always-allow 规则；
2. 必要时向 renderer 发 `tool_permission_request`；
3. 等用户在桌面端卡片上点允许/拒绝；
4. 把结果通过 stdio 回给 CLI。

这意味着：

- **即使 hook 触发了，桌面端仍可能弹自己的卡片**；
- hook 返回 `allow` 是否能让桌面端不再出卡，必须实测；
- 官方文档说 hooks 在权限评估中先运行，但“hook allow 不会跳过 deny/ask 规则”；`PermissionRequest` 是专门的决策事件，理论上可以代用户决定。

### 4.3 Cowork 的 transcript 不在 `~/.claude/projects`

本机：

```
~/.claude/projects/   # 只有 CLI 会话
  -Users-dev-c-work-ai-claude-tmp/
  ...
```

Cowork 的 transcript 在：

```
~/Library/Application Support/Claude-3p/local-agent-mode-sessions/.../.claude/projects/session/*.jsonl
```

所以：

> **只加一个 profile、指向 `~/.claude/projects` 是看不到 Cowork 的。**

### 4.4 现有进程匹配会把桌面端的子进程误认成 Claude Code

现有 `claude-code` profile 的进程正则是：

```
(^|/)claude($|\s)
```

桌面端启动的内嵌 CLI 路径是：

```
.../Claude.app/.../claude-code/2.1.295/.../claude.app/Contents/MacOS/claude
```

它会被这条正则命中，从而在 L1 进程层多出若干 “Claude Code” 条目。

P0 不一定要改，但需要：

- 在 UI 上按 `entrypoint` / 父进程区分；
- 或给 `process-scan` 增加 exclude 能力，把 `claude-code/<version>/` 排除。

## 5. 推荐接入方案

### 5.1 总体

| 面 | 方案 | 代码量 |
|---|---|---|
| Code | 先实测；若 transcript 在 `~/.claude/projects`，直接复用现有 `claude-code` adapter；否则加一个 root 发现 | 0–少量 |
| Cowork | 新增 `claude-desktop` profile + adapter，继承 transcript 基类 | 1 个 adapter + fixtures |
| Chat | 不接 | 0 |

### 5.2 profile 草案

```json
{
  "id": "claude-desktop",
  "label": "Claude Desktop",
  "enabled": true,
  "module": "./claude-desktop.mjs",
  "export": "ClaudeDesktopAdapter",
  "process": {
    "match": ["/Applications/Claude.app/Contents/MacOS/Claude"]
  },
  "session": {
    "kind": "jsonl-transcript",
    "root": "~/Library/Application Support/Claude*",
    "pattern": "local-agent-mode-sessions/*/*/*/.claude/projects/*/*.jsonl"
  },
  "capabilities": {
    "observe": ["process", "transcript"],
    "runEnd": "explicit",
    "attention": "none",
    "approval": "none",
    "control": []
  },
  "hooks": { "kind": "none", "events": {} },
  "approval": {
    "capability": "none",
    "mechanism": "Cowork 使用独立 CLAUDE_CONFIG_DIR，用户级 hook 不加载",
    "note": "只读；远程批准待 Anthropic 提供配置入口"
  }
}
```

注意：

- `root` 用 glob 发现 `Claude` 和 `Claude-3p`；现有 `loadProfiles` 不做 glob，adapter 内部自己展开。
- `attention: "none"` 是诚实的能力声明：没有 hook，就不假装能知道“正在等授权”。
- `runEnd: "explicit"` 成立，因为 transcript 有 `stop_reason === "end_turn"`。

### 5.3 adapter 设计

`ClaudeDesktopAdapter extends TranscriptAdapter`，只覆盖“发现”和“元数据”，不动解析：

| 覆盖点 | 做什么 |
|---|---|
| `listFiles()` | 扫 `Claude*` 下的 `local-agent-mode-sessions/*/*/*/.claude/projects/*/*.jsonl`，并读同目录的 `local_*.json` 做映射 |
| `titleFor(st)` | 优先 `record.title`，其次首问，最后 “Claude Desktop 会话” |
| `idFor()` | 用 `claude-desktop:<sessionId>`；`sessionId` 优先 `local_*` 的完整 id，保证跨进程稳定 |
| 状态补充 | 读 `<sessionDir>/.claude/sessions/<pid>.json` 的 `status`，只作为 `working/idle` 提示，不替代 transcript |
| 过滤 | 只接受 `entrypoint === "local-agent"` 且路径在 `local-agent-mode-sessions` 下的文件；避免把 Code/CLI 混进来 |

不建议：

- 直接解析 `audit.jsonl` 做状态：它是审计格式，不是轮次格式。
- 依赖 `/tmp/cc-socks/*.sock`：这是 Claude Code 的 peer 协议，非公开接口，不能作为产品依赖。

### 5.4 会话身份与 runId

```js
const sessionId = "claude-desktop:" + record.sessionId;
const runId = makeRunId(sessionId, promptId || userEntry.uuid);
```

- `record.sessionId` 形如 `local_<uuid>`，比 8 位目录名稳定。
- transcript 里的 `sessionId` 是 `cliSessionId`，用于和 hook / 命令行对齐；不要把它直接当 mo-agent 的 sessionId。
- 一轮结束：最后一条 assistant 的 `stop_reason === "end_turn"`；同一 `promptId` / 最后一条 user entry 只发一次 `run.completed`。
- 一轮开始：新的 `user` entry（`origin.kind === "human"` 或 `promptSource === "sdk"`）出现时发 `run.started`。

### 5.5 手机端展示

- Agent 标签：`Claude Desktop`
- 会话标题：记录里的 `title`；没有就用首问前 60 字
- 副标题：`Cowork` / `Code` / `Chat`
- 不显示“发送/中断”按钮（`capabilities.control = []`）
- 不显示“可远程批准”，除非后续实测通过

## 6. 远程批准：能做到哪一步

### 6.1 Code 面

现有机制：

```
~/.claude/settings.json
  hooks.PermissionRequest
    -> node approvals/hook-cli.mjs event PermissionRequest claude-code
    -> /local/approval
```

桌面端 Code 面读取同一个文件，所以 **hook 会被加载**。剩下要验证的是：

1. 桌面端 Code 面触发工具授权时，`PermissionRequest` 是否真的触发；
2. hook 返回 `allow` 时，桌面端是否不再弹卡；
3. hook 返回 `deny` 时，桌面端是否直接拒绝；
4. hook 超时/失败时，是否回落到桌面端自己的卡。

官方文档支持“hooks 在终端、IDE、桌面端、云端都会触发”，但桌面端的 `canUseTool` 路径可能改变最后一步的行为，所以必须真机验证，不能只看文档。

### 6.2 Cowork 面

当前不可行，原因不是“没有 hook”，而是 **hook 配置不在它读取的目录**：

```
CLAUDE_CONFIG_DIR=<sessionDir>/.claude
settingSources=["user"]  ->  <sessionDir>/.claude/settings.json
```

可选路线：

| 路线 | 可行性 | 评价 |
|---|---|---|
| 往 `~/.claude/settings.json` 写 hook | ❌ 不被 Cowork 读取 | 不要做 |
| 新建会话时注入 `<sessionDir>/.claude/settings.json` | ⚠️ 技术上可能 | 与应用抢内部目录，版本一变就坏；不做 |
| UI 自动化点桌面端卡片 | ⚠️ 可行但脆弱 | 需要辅助功能权限，且不是“远程批准”；不做 |
| 等官方暴露配置/事件入口 | ✅ 唯一干净路线 | 先只读接入 |

因此 Cowork 的 profile 应明确声明 `approval: "none"`，手机端不出现批准按钮、不承诺“远程放行”。

### 6.3 hook 路由问题

就算 Code 面可用，现有 hook 命令把 agent id 写死成 `claude-code`：

```
node .../approvals/hook-cli.mjs event PermissionRequest claude-code
```

桌面端 Code 会话的 hook 输入里会带 `entrypoint`（例如 `claude-desktop`）和 `session_id`。建议让 `hook-cli` 支持自动识别：

```
entrypoint === "local-agent"        -> claude-desktop（但 Cowork 不会走到这里）
entrypoint === "claude-desktop"     -> claude-desktop
其它 / 缺省                          -> claude-code
```

这样手机卡片上的 Agent 名不会混。

## 7. 实施计划

### P0：只读观测（建议先做）

1. 新建 `adapters/profiles/claude-desktop.json`。
2. 新建 `adapters/claude-desktop.mjs`，继承 `TranscriptAdapter`，实现 glob 发现 + 记录映射。
3. 用本机脱敏 transcript/记录做 fixtures，覆盖：
   - 首次扫描只建基线，不补发历史完成；
   - 运行中 → `end_turn` → 只发一次 `run.completed`；
   - 会话归档 / 目录消失 → `session.removed`；
   - 损坏 JSONL / 缺失记录 → `source.error`，不崩；
   - 同一会话多轮、多个 assistant 消息、sidechain 子代理；
   - `Claude` 与 `Claude-3p` 两个根同时存在。
4. 验证 Code 面是否已被现有 `claude-code` adapter 覆盖；若覆盖，补一条测试说明，不重复造 adapter。
5. 给 `process-scan` 加 exclude（或仅在 UI 层去重），避免桌面端内嵌 CLI 被标成多个 Claude Code。

验收：

```bash
npm test
npm run check
```

全绿；手机端能看到 Cowork 会话、标题、最近一轮状态；不出现“可远程批准”。

### P1：Code 面批准验证

1. 在 `~/.claude/settings.json` 临时加一个只写日志的 `PermissionRequest` / `PreToolUse` hook。
2. 在桌面端 Code 标签页新建会话，触发一次需要授权的 `Write` 或 `Bash`。
3. 检查日志里的 `hook_event_name`、`entrypoint`、`session_id`、`tool_name`。
4. 让 hook 返回 `allow`，确认桌面端是否还出卡、工具是否执行。
5. 让 hook 返回 `deny`，确认是否直接拒绝。
6. 让 hook 超时，确认是否回落到桌面端卡片。

通过后：

- Code 面 profile 标 `approval: "allow"`；
- `hook-cli` 增加 entrypoint 自动路由；
- 手机端 Code 会话出现批准按钮。

不通过则保持只读，和 Cowork 一致。

### P2：体验补齐

- 读取 `waiting-input/`，把“应用认为在等人”映射成 `pending.added`（仅展示，不承诺可批准）。
- 会话状态 `status` 抖动去抖；进程退出/崩溃映射为 `run.failed` 或 `session.removed`，不要伪造成 `completed`。
- 会话标题变更、归档、恢复。
- 多账户 / 多组织目录排序，避免把旧账户的会话显示成当前会话。

## 8. 风险与边界

1. **内部格式，不是公开 API。** `local-agent-mode-sessions`、`claude-code-sessions`、`local-sessions.json`、`.claude/sessions/<pid>.json` 都是桌面端内部结构，随版本变化。适配器必须：
   - 启动时探测目录，不存在就跳过；
   - 解析失败发 `source.error`，不影响其它 Agent；
   - 不写这些目录，只读。
2. **隐私。** transcript 包含完整对话和代码。手机端只发标题、工具名、必要摘要；不要整段回传。
3. **重复会话。** 同一会话可能同时有 record、transcript、live status；以 `cliSessionId` 去重。
4. **迁移。** 桌面端版本升级可能把会话从 `local-agent-mode-sessions` 迁到 `claude-code-sessions`（社区已有相关 issue）。适配器要能同时扫两个根，并按会话 id 去重。
5. **远程 / SSH 会话。** 桌面端支持 SSH 远程会话，transcript 可能在远端主机；本方案只覆盖本机会话。
6. **不要碰 UI 自动化。** 用辅助功能去点桌面端卡片，既脆弱又需要额外权限，不符合“观察优先”的定位。

## 9. 待实测清单

按优先级：

1. **Code 面 transcript 位置**
   - 在桌面端 Code 标签页新建一个会话，发一句会触发工具的话；
   - 同时检查：
     ```bash
     find ~/.claude/projects -name '*.jsonl' -mmin -5
     find ~/Library/Application\ Support/Claude*/claude-code-sessions -name '*.jsonl' -mmin -5
     ```
   - 结论决定：现有 adapter 是否已覆盖 Code。

2. **Code 面 hook 是否触发**
   - 在 `~/.claude/settings.json` 加临时 logging hook；
   - 触发 `Write` / `Bash`；
   - 看日志中的 `entrypoint` 和 `hook_event_name`。

3. **hook allow / deny 的真实效果**
   - allow 是否抑制桌面端卡片；
   - deny 是否直接拒绝；
   - 超时是否回落。

4. **Cowork 是否完全不读 `~/.claude`**
   - 在 `~/.claude/settings.json` 放一个 `SessionStart` logging hook；
   - 新建 Cowork 会话；
   - 看日志是否出现。预期：不出现。
   - 再在会话 `<sessionDir>/.claude/settings.json` 手动放同样的 hook，确认它只在手动注入时生效。

5. **AskUserQuestion 的等待状态**
   - 让 Cowork 会话问一个问题；
   - 检查 `<sessionDir>/waiting-input/` 的文件名和内容；
   - 决定是否接入 `pending.added`。

6. **版本矩阵**
   - 记录 Claude Desktop 版本、内置 Claude Code 版本、目录结构；
   - 至少验证当前版本 + 下一个版本，避免升级即坏。

## 10. 参考

- Claude Code hooks 参考（官方明确：终端、IDE、桌面端、云端触发同一套 hook 事件）：
  <https://code.claude.com/docs/en/hooks>
- Agent SDK 权限评估顺序（hooks → deny → ask → mode → allow → canUseTool）：
  <https://code.claude.com/docs/en/agent-sdk/permissions>
- Claude Code Desktop 快速开始：
  <https://code.claude.com/docs/en/desktop-quickstart>
- 社区 issue：桌面端 Code 会话历史迁移 / `claude-code-sessions` 目录：
  <https://github.com/anthropics/claude-code/issues/29373>
  <https://github.com/anthropics/claude-code/issues/27463>

## 11. 最终建议

**值得接，但不要一上来就承诺“手机远程批准”。**

- **Code 面**：先花半天实测。通过就是现有 Claude Code 能力的自然延伸，性价比最高。
- **Cowork 面**：P0 只做“看见 + 完成通知”。它的 transcript 完整、`end_turn` 明确，观测价值很高；但配置隔离决定了用户级 hook 进不去，远程批准暂时不要碰。
- **Chat 面**：不接。没有本地会话数据，硬接只能看进程，投入产出不成立。

如果只做一件事：**先验证 Code 面是否已经能被现有 `claude-code` 适配器看到。** 这是整个评估里唯一可能“零代码落地”的部分。
