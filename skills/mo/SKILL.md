---
name: mo
description: 把讨论落成任务卡并派给执行 Agent。用户说"开始做/落地/派给 X/就这么办"，或要查看任务进度与验收结果时使用。
license: PolyForm-Noncommercial-1.0.0
compatibility: 需要 mo CLI（单文件二进制或 npm 包）。安装见仓库 scripts/install-cli.sh 或 install-remote.sh。
metadata:
  author: mo-agent
  homepage: https://github.com/<org>/mo-agent
---

# mo

用 `mo` 把"聊出来的想法"固化成任务卡，再派给执行 Agent（Claude / Codex / Qoder / pi / qwen），最后按账本汇报。

## 前提

```bash
mo --version          # 不可用 → 见下面的「mo 还没装」
mo doctor             # 顺带确认当前目录属于某个项目
```

当前目录不是项目时，先问用户是否要 `mo project add .`，**不要自动建**。

### mo 还没装

**不要自己猜命令，也不要继续建卡。** 停下来告诉用户：技能已就位，但 `mo` 不在 PATH 里，然后给出两种安装方式（二选一）：

```bash
# 方式一：Release 单文件二进制（不需要 Node，装完同时装技能）
curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/install-remote.sh | bash

# 方式二：源码（需要 git 与 Node 18+）
git clone https://github.com/<org>/<repo>.git
cd mo-agent
bash scripts/install-cli.sh
```

源码方式里，没有 bun 时安装脚本会退化为软链到仓库（需要 Node）；有 bun 则构建单文件二进制。

用户装完后，让 ta 重开终端（或按安装脚本打印的那行命令刷新），再执行 `mo --version` 确认。

## 什么时候动手

| 用户说 | 你做什么 |
|---|---|
| 聊想法、聊方案 | 只聊，不碰任何 `mo` 命令 |
| "开始做 / 落地 / 派给 X" | 建卡 → 念给用户 → 等确认 → 派单 |
| "怎么样了 / 做完了吗" | 读 `mo task status`，按事实汇报 |
| 纠正你的做法 | 不要自己改卡；问用户要不要改 |

## 建卡

先把三个字段问清楚：**交付物、验收标准、边界**。缺验收标准要明确提醒，不要静默建卡。

```bash
mo task create \
  --title "一句话说明" \
  --deliverable "可验收的产出" \
  --verify "run:npm test -- --filter x" \
  --verify "check:dist/index.html 存在" \
  --boundary "不要改后端接口" \
  --agent claude \
  --json
```

`--agent` 用内置模板（`mo agents` 看清单和本机是否安装）；需要额外参数时改用 `--exec "<完整命令>"`，两者互斥。

## 派单前必须回显

把卡摘要给用户，然后**停下等确认**：

```text
任务：t_01H…
项目：mo-agent
交付：app/web/tasks.html 加筛选栏
验收：run npm test --filter tasks / human 视觉确认
执行：claude（claude -p …）
派发吗？
```

用户确认后：

```bash
mo task confirm <taskId>
mo task dispatch <taskId> --json
```

`dispatch` 是**前台等待**的：执行者跑完才返回，可能几分钟。可以先把"已开始"告诉用户。

## 汇报

只引用工具返回的事实，不要替执行者说"完成了"。

```bash
mo task status <taskId> --json
mo ledger query --task <taskId> --json
```

- `done` + `verified: unverified` → 说"执行者交付了，验收还没跑"（verify 自动执行尚未实现）；
- `blocked` → 说清 `reason`、`exitCode`、`outputTail`；
- `failed` → 同样转述，不要美化。

## 铁律

1. **没确认不派单**：`dispatch` 会返回 `E_NOT_CONFIRMED`；
2. **没拿到 taskId 不许说"已派发"**；
3. **执行者退出码 0 但没有回执 = 未完成**（`blocked(missing_receipt)`）；
4. **不要手改** `.mo-agent/tasks/*.md`，除非用户明确要求；
5. **不要自己写回执**——回执属于执行者，伪造等于把系统变成摆设；
6. 一次对话最多派 3 个任务；不确定就停下来问。

## 常见失败

| 返回 | 意思 | 你说什么 |
|---|---|---|
| `E_NOT_CONFIRMED` | 卡还没确认 | "还差确认，要现在确认吗？" |
| `E_PROJECT_UNBOUND` | 当前目录不是项目 | 问是否 `mo project add .` |
| `E_NO_EXECUTOR` | 卡里没执行者 | 问用哪个 `--agent` |
| `blocked(missing_receipt)` | 执行者没写回执 | 转述 `outputTail`（常见：未登录） |
| `blocked(bad_receipt)` | 回执不合法 | 转述 `errors` |
| `blocked(timeout)` | 超时 | 问重试还是换执行者 |

## 没有 skill 机制时

把下面这段放进项目或全局的 `CLAUDE.md` / `AGENTS.md`：

```text
要把讨论落地时，用 mo CLI：
1) 先补齐交付物、验收标准、边界，再 mo task create --agent <claude|codex|qodercli|qoderclicn|pi|qwen>；
2) 把卡摘要给用户，等确认；
3) 确认后 mo task confirm，再 mo task dispatch；
4) 只按 mo task status / mo ledger 的实际结果汇报，不要替执行者宣称完成。
执行者没写回执（missing_receipt）一律视为未完成。
```