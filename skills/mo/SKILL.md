---
name: mo
description: 把讨论落成任务卡并派给执行 Agent。用户说"开始做/落地/派给 X/就这么办"，要查看任务进度与验收结果，或要安装/初始化 mo 工具时使用。
license: PolyForm-Noncommercial-1.0.0
compatibility: 需要 mo CLI（单文件二进制或 npm 包）。安装见仓库 scripts/install-cli.sh 或 install-remote.sh。
metadata:
  author: mo-agent
  homepage: https://github.com/insky2005/mo-agent
---

# mo

用 `mo` 把"聊出来的想法"固化成任务卡，再派给执行 Agent（Claude / Codex / Qoder / pi / qwen），最后按账本汇报。

## 前提

```bash
mo --version          # 不可用 → 见下面的「mo 还没装」
mo doctor             # 顺带确认当前目录属于某个项目
```

当前目录不是项目时，先问用户是否要 `mo project init .`，**不要自动建**。

### mo 还没装

**不要自己猜命令，也不要继续建卡。** 先说明情况，并**征得用户明确同意**再动手——安装会下载二进制、写 `~/.local/bin`，属于改动用户机器。

#### 用户同意由你安装

```bash
TMP="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/scripts/install-remote.sh -o "$TMP"
bash "$TMP"

~/.local/bin/mo --version     # PATH 可能还没刷新，先用绝对路径验证
~/.local/bin/mo skill list    # 确认技能也装上了
```

装完告诉用户两件事：

1. **重开终端**后 `mo` 才会在 PATH 里；当前会话用绝对路径 `~/.local/bin/mo` 也能继续；
2. 新终端里执行 `mo --version` 确认。

之后用绝对路径继续建卡派单是可以的，不需要等用户重开。

#### 用户不同意，或想自己装

给出两条命令，然后停下：

```bash
# Release 单文件二进制（不需要 Node；加 --with-skill 会顺带装技能）
curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/scripts/install-remote.sh | bash

# 源码（需要 git 与 Node 18+）
git clone https://github.com/insky2005/mo-agent.git
cd mo-agent
bash scripts/install-cli.sh
```

源码方式里，没有 bun 时安装脚本会退化为软链到仓库（需要 Node）；有 bun 则构建单文件二进制。

**不要 `curl … | bash` 一把梭**：先把脚本下到临时文件，让用户有机会先看一眼再执行。

## 什么时候动手

用户输入 `/mo`、提到本技能、或在相关话题里跟你说话——**默认就是"聊"**：正常对话，不建卡、不派单、不碰任何 `mo` 命令。技能被加载不代表要立刻执行动作。

只有出现明确的信号才进下一步：

| 信号 | 动作 |
|---|---|
| 要落地（"开始做 / 落地 / 派给 X / 就这么办"） | 建卡 → 回显 → 等确认 → 派单 |
| 问进度（"怎么样了 / 做完了吗"） | 读 `mo task status`，按事实汇报 |
| 纠正你的做法 | 问用户要不要改，不自己改卡 |
| 其它情况（默认） | 只聊 |

## 建卡

先把三个字段问清楚：**交付物、验收标准、边界**。缺验收标准要明确提醒，不要静默建卡。

```bash
mo task create \
  --title "一句话说明" \
  --deliverable "可验收的产出" \
  --verify "run:npm test -- --filter x" \
  --verify "check:dist/index.html 存在" \
  --boundary "不要改后端接口" \
  --worker claude \
  --json
```

`--worker` 用内置执行者（`mo worker list` 看清单和本机是否安装）；需要额外参数时改用 `--exec "<完整命令>"`，两者互斥。

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

## 账本里的发起者

账本的 `发起` 列只有四种值：

- `agent`：通过 `mo task ...` 发起的动作（建卡、派单、取消）
- `human`：确认（`mo task confirm`），只有这一种动作强制由人拍板
- `core`：内核自己的判定（完成、阻塞、验收）
- `worker`：执行者交回执

不要替用户执行确认——不是怕记录，是确认权在用户手里。

## 铁律

1. **没确认不派单**：`dispatch` 会返回 `E_NOT_CONFIRMED`；
2. **没拿到 taskId 不许说"已派发"**；
3. **执行者退出码 0 但没有回执 = 未完成**（`blocked(missing_receipt)`）；
4. **不要手改** `.mo-agent/tasks/*.md`，除非用户明确要求；
5. **不要自己写回执**——回执属于执行者，伪造等于把系统变成摆设；
6. 一次对话最多派 3 个任务；不确定就停下来问；
7. **安装软件、修改 shell 配置前必须得到用户明确同意**，不做"顺手就装了"。

## 常见失败

| 返回 | 意思 | 你说什么 |
|---|---|---|
| `E_NOT_CONFIRMED` | 卡还没确认 | "还差确认，要现在确认吗？" |
| `E_PROJECT_UNBOUND` | 当前目录不是项目 | 问是否 `mo project init .` |
| `E_NO_EXECUTOR` | 卡里没执行者 | 问用哪个 `--worker` |
| `blocked(missing_receipt)` | 执行者没写回执 | 转述 `outputTail`（常见：未登录） |
| `blocked(bad_receipt)` | 回执不合法 | 转述 `errors` |
| `blocked(timeout)` | 超时 | 问重试还是换执行者 |