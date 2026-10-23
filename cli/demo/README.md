# 手动测试用例

在**任意目录**里验证 `mo` 的完整闭环。全程本地、不联网、不花钱，用的是仓库自带的假执行者。

预计 3 分钟。

## 前置

```bash
mo --version        # 有输出即可
```

没有安装的话，用仓库路径代替：

```bash
alias mo='node /Users/dev/c/work.ai/deepseek-harness/mo-agent/cli/mo.mjs'
```

本文里的 `REPO` 指仓库根目录：

```bash
REPO=/Users/dev/c/work.ai/deepseek-harness/mo-agent
```

## 0. 准备一个干净的测试目录

随便找一个**你不在乎的目录**（新建也行）：

```bash
mkdir -p /tmp/mo-case && cd /tmp/mo-case
export MO_AGENT_HOME="$PWD/.mo-test-home"   # 隔离，不污染 ~/.mo-agent
```

> 隔离 `MO_AGENT_HOME` 的目的：测试产生的账本、项目登记都关在这个目录里，删掉即干净。
> 想直接用自己的真实环境，跳过这行 export。

## 1. 登记项目

```bash
mo project add .
```

**预期**：输出项目名、`p_` 开头的 id、根目录。

```
已登记项目 mo-case
  id:   p_01M5…
  根目录: /tmp/mo-case
```

**判定**：目录下出现 `.mo-agent/project.json`。

```bash
ls .mo-agent
# README.md  project.json  .gitignore
```

## 2. 建卡

```bash
mo task create \
  --title "生成 demo-output.txt" \
  --deliverable "demo-output.txt 存在且非空" \
  --verify "check:demo-output.txt 存在" \
  --exec "node $REPO/cli/demo/executor.mjs"
```

**预期**：状态 `draft`，给出任务卡路径。

**判定**：

```bash
grep -E '^(status|exec):' .mo-agent/tasks/*.md
# status: draft
# exec: node /…/cli/demo/executor.mjs
```

## 3. 确认

把上一步的 id 记下来：

```bash
TASK=$(ls .mo-agent/tasks/*.md | head -1 | xargs basename | sed 's/\.md$//')
echo "$TASK"
```

```bash
mo task confirm "$TASK"
```

**预期**：`→ confirmed`，并提示“可以派发”。

**判定**：没确认就派单会被拒（这是设计，稍后会单独验证）。

## 4. 派单

```bash
mo task dispatch "$TASK"
```

**预期**：

```
t_01M5… → done
执行者: node /…/cli/demo/executor.mjs
验收: unverified
结论: 演示执行者：已按卡交付
回执: /tmp/mo-case/.mo-agent/receipts/t_01M5….json
```

## 5. 验收（四项都要对）

```bash
mo task status "$TASK"
cat demo-output.txt
cat .mo-agent/receipts/"$TASK".json
mo ledger query --task "$TASK"
```

| 检查 | 通过标准 |
|---|---|
| 状态 | `[done]` |
| 产物 | `demo-output.txt` 存在、内容非空 |
| 回执 | JSON 里 `taskId` 与任务一致，`status: done`，`verify` 非空 |
| 账本 | 出现 `created → confirmed → dispatched → receipt.received → completed` |

## 6. 失败用例：执行者不写回执

```bash
TASK2=$(mo task create --title "不写回执" --deliverable 随便 --exec 'exit 0' --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).taskId))')
mo task confirm "$TASK2"
mo task dispatch "$TASK2"
```

**预期**：

```
t_01M5… → blocked
原因: missing_receipt
执行者退出码: 0
```

**判定**：退出码是 0 **也不算成功**。整条链只有“回执合法”才算完成。

## 7. 失败用例：没确认就派单

```bash
TASK3=$(mo task create --title "没确认" --deliverable 随便 --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).taskId))')
mo task dispatch "$TASK3"
```

**预期**：退出码 1，stderr 出现：

```
[E_NOT_CONFIRMED] 任务卡还没确认，先执行 mo task confirm …
```

## 8. 重试：换一个执行者

```bash
mo task dispatch "$TASK2" --exec "node $REPO/cli/demo/executor.mjs"
```

**预期**：`→ done`，账本里 TASK2 的时间线变成：

```
created → confirmed → dispatched → blocked → receipt.received → completed
```

**判定**：`blocked` 是“可以恢复”的，不用重新建卡。

## 9. 接真实 Agent（可选）

假执行者全过之后，换成真实 Agent：

```bash
echo "说一句 OK" | claude -p "$(cat)"              # 先确认登录正常
mo task create --title "真实任务" --deliverable 说明 \
  --exec 'claude -p "$(cat)"'
```

看到 `Not logged in` 就先登录，别急着派单。

## 10. 清理

```bash
cd /tmp && rm -rf /tmp/mo-case
```

因为 `MO_AGENT_HOME` 指在测试目录里，这一条命令就清干净了。

## 通过标准汇总

| # | 用例 | 期望 |
|---|---|---|
| 1 | 登记项目 | 生成 `.mo-agent/project.json` |
| 2 | 建卡 | 状态 `draft`，卡里记录执行者 |
| 3 | 确认 | `draft → confirmed` |
| 4 | 派单 | `confirmed → done` |
| 5 | 验收 | 产物、回执、账本、状态四项一致 |
| 6 | 无回执 | `blocked(missing_receipt)`，退出码 0 也不行 |
| 7 | 未确认派单 | `E_NOT_CONFIRMED`，退出码 1 |
| 8 | 重试 | `blocked → done`，账本留完整轨迹 |

八条全过，说明 CLI 的闭环是通的。

> 想一键看同样的流程：`bash cli/demo/run.sh`。它会自建临时目录、自动跑完四个场景。
