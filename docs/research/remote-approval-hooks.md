# 预研：哪些 Agent 支持「远程批准」（remote approval）

日期：2026-10-16

## 0. 判定标准

「远程批准」要成立，Agent 必须提供一个**能做决策的拦截点**，而不只是发通知。按能力分三档：

| 档位 | 含义 | 能否远程批准 |
|---|---|---|
| **放行型（allow-capable）** | hook 能返回 allow，替用户跳过确认 | ✅ 能 |
| **仅拦截型（block-only）** | hook 只能 deny/block，不能 allow | ❌ 不能（只能远程拒绝） |
| **仅通知型（notify-only）** | 只告诉你发生了事，无决策权 | ❌ 不能 |

关键区别：**能拦不等于能批**。Codex 就是典型的「能拦不能批」。

## 1. 逐个 Agent 的结论

| Agent | 机制 | 放行 | 拒绝 | 依据 / 备注 |
|---|---|---|---|---|
| **Claude Code** | `PermissionRequest` hook | ✅ | ✅ | 官方原文：allow or deny a permission request **on behalf of the user**；还能改工具输入、落权限规则。**最强** |
| **Cursor** | 权限类 hooks：`beforeShellExecution` / `preToolUse` / `beforeMCPExecution` / `beforeReadFile` / `subagentStart` | ✅ | ✅ | hook 是 stdio 子进程，返回 `permission: allow / deny`；exit 2 等于 deny |
| **Gemini CLI** | `BeforeTool` hook | ✅ | ✅ | 输出字段 `decision: allow / deny`（deny 别名 block） |
| **Qwen Code** | hooks（与 Gemini CLI 同源） | ✅ | ✅ | 文档同样出现 hookSpecificOutput，建议实测确认 |
| **GitHub Copilot CLI** | `preToolUse` hook，`permissionDecision` | ⚠️ | ✅ | 支持 allow，但已知 bug：即使 allow 仍会弹确认框（issue #2643） |
| **OpenCode** | `permission.ask` 插件 hook | ⚠️ | ⚠️ | 已定义但接入不全：首遇命令会被绕过；有多个 issue / PR 在修 |
| **Codex CLI** | hooks | ❌ | ✅ | hook 只能 block，无 pre-tool 批准路径。**但走 ACP 可以**（见下） |
| **Kimi CLI** | — | ❌ | ❌ | 尚未支持；有 open issue 要求「审批也要触发 hook」 |
| **Cline** | SDK 的 Permission Handling | 🟡 | 🟡 | 是「由你来跑它」的编程式审批，不是旁路 hook |
| **Goose** | gotohuman-mcp 扩展 | 🟡 | 🟡 | 经 MCP 集成做人机协同，不是 hook |
| **Aider** | — | ❌ | ❌ | 终端 y/n，无拦截点 |
| **Windsurf / Kiro** | — | ❌ | ❌ | IDE 内部，无外部决策点 |

## 2. 两条互补路线

### 路线 A：Hook（能批「用户自己跑」的会话）

适用：Claude Code、Cursor、Gemini CLI、Qwen Code、Copilot CLI（带 bug）。

优点：用户照常在自己终端里跑，我们只在卡点介入。
缺点：每家 hook 格式不同（要写 profile）；需要用户装一次 hook 配置。

### 路线 B：ACP（能批「我们托管」的会话）

任何实现了 ACP `session/request_permission` 的 Agent 都行 —— Claude Code、Codex、Gemini、Cursor、Copilot、OpenCode、Qwen、Kimi 都有 ACP 适配器。

优点：一套客户端吃一整片生态，协议标准。
缺点：**必须由我们启动会话**，用户自己跑的那些管不到。

**结论：两条都要，面向不同场景。** Codex 只能靠路线 B。

## 3. 机制设计

```
Agent 即将执行工具
   ↓
hook 子进程被启动，stdin 收到 JSON（会话、工具名、参数）
   ↓
POST 本地mo-agent daemon（带请求 id + 超时）
   ↓
daemon 决策：
   a) 命中本地白名单        → 立即 allow（不动手机）
   b) 需要人                → 推手机 + 阻塞等待
   c) 手机不可达 / 超时      → 返回「不决策」，交回本地终端提示  ⭐
   ↓
hook 输出 allow / deny
```

### ⭐ 最重要的一条：失败要「交回本地终端」，而不是 fail-open 或 fail-closed

如果mo-agent挂了或手机不在线：
- fail-open（直接放行）→ 等于绕过所有安全确认，危险；
- fail-closed（直接拒绝）→ Agent 会卡死，用户会很烦；
- **交回本地终端**（hook 不做决策 / exit 0）→ 用户在原终端照常看到提示，体验无损。

这是这个功能能不能被接受的关键设计点。

## 4. 风险与注意事项

1. **Hook 超时**：Cursor 的 hook 可配 `timeout`（示例 30 秒）。如果要等人，必须能配到很长或按需阻塞，否则人还没点就超时了。每个 Agent 的超时上限与超时后的行为都要实测。
2. **daemon 变成「权限神谕」**：它决定放不放行，等于持有你电脑的命令执行权。必须做：请求鉴权、来源校验、审计日志、可随时关闭。
3. **hook 是子进程**：要注意它继承的环境、工作目录、以及被杀掉时的清理。
4. **版本漂移**：hook 的 JSON 格式随版本变（Copilot 的 allow 弹框 bug 就是例子）。profile 要按版本做兼容。
5. **首次安装引导**：每接一个 Agent 都要写一次 hook 配置，这是用户流失点，要做得极简（一条命令 / 一个开关）。

## 5. 建议的首发目标

**Claude Code 一个就够验证价值。** 理由：
- 官方文档明确说 hook 可以「代替用户」批准（唯一一家写得这么直白的）；
- 支持 allow 且能改输入、能落权限规则；
- 用户基数大；
- 一个跑通，整条链路（通知 → 手机 → 决策 → 回填）就被证明了。

之后按性价比排序接入：Cursor（同为放行型，且 IDE 用户多）→ Gemini CLI / Qwen Code（同源，几乎免费）→ Copilot CLI（修掉那个 bug 后）→ Codex（走 ACP 路线）。

## 6. 参考链接

- Claude Code hooks：https://code.claude.com/docs/en/hooks
- Cursor hooks：https://cursor.com/docs/hooks
- Gemini CLI hooks：https://geminicli.com/docs/hooks/reference/
- Qwen Code hooks：https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/
- GitHub Copilot hooks：https://docs.github.com/en/copilot/reference/hooks-reference
- Copilot allow 仍弹框 issue：https://github.com/github/copilot-cli/issues/2643
- OpenCode permission.ask issue：https://github.com/anomalyco/opencode/issues/7006
- Kimi CLI 审批不触发 hook issue：https://github.com/MoonshotAI/kimi-cli/issues/2337
- ACP：https://agentclientprotocol.com
