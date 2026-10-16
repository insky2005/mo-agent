# 预研：国产 Agent 的 hook / 远程批准能力

日期：2026-10-16

## 0. 先说一个关键前提：Agent 不等于模型

国内相当大一部分「用国产 Agent」的场景，其实是 **Claude Code / Codex 换了个国产模型端点**（GLM、Kimi K2、Qwen、DeepSeek 都提供 Anthropic / OpenAI 兼容接口，直接改 base URL 就行）。

这种情况下：**Agent 本体还是 Claude Code，hook 能力完全等同 Claude Code**，我们前面查到的 `PermissionRequest` 照样可用。

所以「国产 Agent」这个问题要先拆成两类：
- A 类：国产模型 + 国外 Agent 壳 → **能力跟该壳一致，不用单独评估**
- B 类：真正国产的 Agent CLI → 需要逐个评估，见下

## 1. 真正国产 CLI 的能力盘点

| Agent | 厂商 | Hook | 能放行 | ACP | 结论 |
|---|---|---|---|---|---|
| **Qoder CLI** | 阿里 | ✅ 完整 | ✅ | ✅ `qodercli --acp` | **最强**。hook 设计几乎照抄 Claude Code：`PreToolUse` 支持 `permissionDecision: allow / deny / ask`、`updatedInput`、`additionalContext`，并单独有 `PermissionRequest` 事件 |
| **Qwen Code** | 阿里 | ✅ | ✅ | ✅ `qwen --acp` | 与 Gemini CLI 同源，`decision: allow / deny` |
| **CodeBuddy** | 腾讯 | ✅ 有 Hooks 参考文档 | 待确认 | — | 文档存在（codebuddy.cn/docs/cli/hooks），内容未取到，需实测 |
| **iFlow CLI** | 心流 | ✅ 有 | 待确认 | ✅ `iflow --experimental-acp` | 有 hooks 示例文档，是否支持 allow 需实测 |
| **Trae** | 字节 | ⚠️ 企业版 | 待确认 | ✅ `traecli acp serve` | **仅企业版（旗舰版）**支持；事件有 SessionStart / PreToolUse / PostToolUse / Stop / Notification；**只支持 HTTP 类型 hook**（直接 POST 到你的端点，这反而很适合我们） |
| **Kimi CLI** | 月之暗面 | ⚠️ Hooks (Beta) | ❌ 目前不行 | ✅ `kimi acp` | 有两个 open issue：审批提示不触发 hook；`Notification` hook 的 `permission_prompt` matcher 从不触发。**审批路径目前是坏的** |
| **通义灵码 / Comate / 文心快码** | 阿里 / 百度 | ❌ | ❌ | — | IDE 插件为主，无外部决策点 |

## 2. ACP 覆盖：国产 agent 反而很积极

ACP registry 里的国产/中文区 Agent 已经有：

```
qwen   →  qwen --acp
kimi   →  kimi acp
iflow  →  iflow --experimental-acp
trae   →  traecli acp serve
qoder  →  qodercli --acp
```

也就是说：**即使 hook 路线不通，只要走 ACP 托管，`session/request_permission` 就能把审批推到手机。** 国产 Agent 在 ACP 上的跟进速度不比国外慢。

## 3. 两个值得注意的国产特点

1. **HTTP hook 更常见**。Trae 企业版明确「仅支持 HTTP 类型 Hook」，直接 POST 到你的端点。这对我们反而更省事：不需要写子进程脚本来回调 daemon，直接注册一个 URL 就行。可以预期其它国产 Agent 也会偏向 HTTP hook。
2. **企业版门槛**。Trae 的 Hook 要求旗舰版套餐。这类能力可能被当成商业化卖点，个人免费版未必能用，做产品时要考虑用户的实际版本。

## 4. 结论与建议

- **不要按厂商做适配，按机制做适配**。我们的五档能力模型（放行型 / 仅拦截型 / 仅通知型 / ACP / 无）已经能覆盖国产和国外所有情况，加一个 Agent 就是加一份 profile。
- **首发仍然建议 Claude Code**：它同时也是大量国内用户实际在用的壳（配国产模型），覆盖面比单看厂商大。
- **国产优先级**：Qoder（能力最全，且阿里系企业渗透高）→ Qwen Code（与 Gemini 同源，适配几乎免费）→ CodeBuddy / iFlow（需实测确认能否放行）→ Trae（企业版 + HTTP hook，接入简单但要谈版本）→ Kimi（等审批 hook 修好）。
- **ACP 作为兜底**：对任何走 ACP 的国产 Agent，即使没有 hook，也能通过托管路线提供远程批准。

## 5. 参考链接

- Qoder CLI Hooks：https://docs.qoder.com/cli/hooks-reference
- Qoder CLI ACP：https://docs.qoder.com/cli/acp
- Qwen Code Hooks：https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/
- CodeBuddy Hooks：https://www.codebuddy.cn/docs/cli/hooks
- iFlow Hooks：http://docs.iflow.cn/cli/examples/hooks/
- Trae 企业 Hook：https://docs.trae.cn/enterprise_automate-actions-with-hooks
- Kimi CLI Hooks：https://www.kimi.com/code/docs/kimi-code-cli/customization/hooks.html
- Kimi 审批 hook issue：https://github.com/MoonshotAI/kimi-cli/issues/2337
- Kimi Notification 不触发 issue：https://github.com/MoonshotAI/kimi-cli/issues/2048
