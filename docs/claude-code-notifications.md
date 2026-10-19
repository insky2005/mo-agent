# Claude Code 通知类型清单

> 依据：本机 Claude Code **2.1.296** 的内置通知类型表与各发送点，以及
> [Hooks reference · Notification](https://code.claude.com/docs/en/hooks) 的 matcher 说明。
> 这份清单用于决定 mo-agent 要转发 / 过滤哪些通知。

## 通知是怎么发出来的

Claude Code 的 Notification hook 输入（stdin）大致是：

```json
{
  "hook_event_name": "Notification",
  "message": "Claude is waiting for your input",
  "title": "Claude Code",
  "notification_type": "idle_prompt"
}
```

- `title` 可选；Claude Code 自己的系统通知默认标题是 **`Claude Code`**；
- `message` 是正文，下面表格里的模板都指这个字段；
- `notification_type` 决定类型，也是 hook `matcher` 过滤的依据；
- 插件通知的标题会变成**插件名**（没有单独传时才回退到 `Claude Code`）。

mo-agent 不使用 Claude Code 的 `title` 字段，而是按 `notification_type` 映射成统一标题，
再把 Agent 名追加到标题后：例如 **`等待回答 [Claude Code]`**。
正文是 **`<会话标题> · <message>`**（会话标题能按 `session_id` 解析到时才加）。

## 类型清单（按内置表顺序）

| # | `notification_type` | 触发场景 | Claude Code 标题 | 正文模板（`message`） |
|---|---|---|---|---|
| 1 | `permission_prompt` | 工具调用需要授权，或需要用户确认某个对话框 | `Claude Code` | `Claude needs your permission to use <toolName>`；对话框场景也可能是 `Claude needs your permission` |
| 2 | `idle_prompt` | 一轮结束 / 终端失焦，空闲等待输入 | `Claude Code` | `Claude is waiting for your input` |
| 3 | `auth_success` | 登录成功 | `Claude Code` | `Claude Code login successful` |
| 4 | `elicitation_dialog` | MCP elicitation 表单等待用户填写 | `Claude Code` | `Claude Code needs your input` |
| 5 | `agent_needs_input` | 后台 Agent / 队友任务需要输入 | `Claude Code` | `<label> needs your input`；`<label> needs your input: <needs，截断 120 字>`；`Teammate setup needs your input`；`Auto mode has a classifier billing notice to acknowledge` |
| 6 | `agent_completed` | 后台 Agent / 队友任务结束 | `Claude Code` | `<label> finished` 或 `<label> failed` |
| 7 | `elicitation_url_dialog` | MCP elicitation 需要打开链接 / URL 确认 | `Claude Code` | `Claude Code needs your input`；MCP 链接场景为 `An MCP server needs your input` |
| 8 | `worker_permission_prompt` | Agent 团队里的 worker 需要授权，或需要网络访问 | `Claude Code` | `<workerName> needs permission for <toolName 或 "(unnamed tool)">`；`<workerName> needs network access to <host 或 "a host">` |
| 9 | `push_notification` | 模型主动调用 PushNotification 工具推送 | `Claude Code` | 工具调用时传入的任意文本 |
| 10 | `computer_use_enter` | Claude 开始操作电脑 | `Claude Code` | `Claude is using your computer · press Esc to stop`（或 `· press Ctrl+C to stop`） |
| 11 | `computer_use_exit` | Claude 结束操作电脑 | `Claude Code` | `Claude is done using your computer` |
| 12 | `quota_auto_resume_fired` | 用量限制到期，自动继续任务 | `Claude Code` | `Usage limit reset — Claude is continuing your task`；提前恢复时为 `Usage limit available — Claude is continuing your task` |
| 13 | `quota_auto_resume_stale` | 用量限制已重置，但需要手动回车继续 | `Claude Code` | `Usage limit reset — press enter to continue` |
| 14 | `quota_auto_resume_disabled` | 自动继续被关闭 / 无法继续 | `Claude Code` | `Automatic continue was turned off — the task will not resume on its own`；`Automatic continue stopped — the usage limit now resets more than 24 hours out; the task will not resume on its own`；`Automatic continue did not run — the continuation was blocked before it reached the model; send a prompt to continue`；`Automatic continue stopped after repeated usage-limit hits — the task will not resume on its own` |
| 15 | `model_refusal_fallback` | 主模型拒答后切换到备用模型（2.1.296 中声明了类型，未发现实际通知发送点，可能保留/未启用） | `Claude Code` | 无固定模板；若有，正文来自 `model_refusal_fallback` system 消息内容 |
| 16 | `auth_storage_failure` | 登录成功但凭据保存失败 | `Claude Code` | `Claude Code login needs attention: credentials may not have been saved`；`Claude Code login needs attention: credentials could not be saved` |
| 17 | `plugin_notification` | 插件调用 `$.ui.notify` | **插件名** | 插件传入的任意文本 |

## mo-agent 当前实际展示

| 环节 | 值 |
|---|---|
| 手机通知标题 | `<映射标题> [Claude Code]`，例如 `等待回答 [Claude Code]` |
| 手机通知正文 | `<会话标题> · <Claude Code 的 message>`；解析不到会话标题时只留 message |
| 通知级别 | 授权/等待回答 = critical，完成/登录/用量/电脑操作 = normal |

`notification_type` 到 mo-agent 标题的映射：

| Claude Code 类型 | mo-agent 标题 | 级别 |
|---|---|---|
| `permission_prompt` / `worker_permission_prompt` | 授权请求 | critical |
| `idle_prompt` / `agent_needs_input` / `elicitation_dialog` / `elicitation_url_dialog` | 等待回答 | critical |
| `agent_completed` | 任务完成 | normal |
| `auth_success` | 登录成功 | normal |
| `auth_storage_failure` | 登录异常 | critical |
| `quota_auto_resume_fired` | 用量恢复 | normal |
| `quota_auto_resume_stale` / `quota_auto_resume_disabled` | 用量限制 | normal |
| `computer_use_enter` / `computer_use_exit` | 电脑操作 | normal |
| `model_refusal_fallback` | 模型切换 | normal |
| `plugin_notification` / `push_notification` | 提醒 | normal |
| 未知类型 | 提醒 | critical |

映射表在 `approvals/claude-notifications.mjs`，标题后缀和正文前缀在 `core/contract.mjs`。

## 如果要按类型处理

- **只想保留真正需要你操作的通知**：过滤 `idle_prompt`、`auth_success`、`quota_auto_resume_*`、`computer_use_*`；
- **只想保留授权**：matcher 设为 `permission_prompt|worker_permission_prompt`，或干脆不装 Notification（只留 PermissionRequest）；
- **想区分标题**：已经按 `notification_type` 映射（见上表），标题会带 `[Claude Code]`；
- **想少一点噪音但保留"等待回答"**：只丢掉 `idle_prompt` 中终端失焦触发的场景较难区分，建议直接按类型过滤。
