#!/usr/bin/env bash
# 逐步走一遍完整流程：初始化 → 建卡 → 确认 → 派单（自动验收）→ 查看。
#   bash cli/demo/walkthrough.sh          # 每步回车继续
#   MO_DEMO_YES=1 bash cli/demo/walkthrough.sh   # 一次跑完（测试用）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MO="$ROOT/cli/mo.mjs"
EXECUTOR="$ROOT/cli/demo/executor.mjs"

TMP="$(mktemp -d)"
PROJECT="$TMP/shop"
mkdir -p "$PROJECT"
export MO_AGENT_HOME="$TMP/home"
cd "$PROJECT"

pause() {
  if [ "${MO_DEMO_YES:-0}" = "1" ]; then return 0; fi
  read -r -p "  回车继续… " _
}

step() { printf "\n\033[1m%s\033[0m\n" "$1"; pause; }
run() { printf '\033[2m$ %s\033[0m\n' "$*"; "$@"; }
ask_id() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).taskId))'; }

printf "演示目录：%s\n" "$TMP"
printf "所有状态都隔离在 %s，不影响你的 ~/.mo-agent\n" "$TMP/home"

step "1/7 初始化项目（.mo-agent/ + AGENTS.md）"
run node "$MO" project init .

step "2/7 看有哪些执行者"
run node "$MO" worker list

step "3/7 建一张卡：验收是「命令能返回 0」"
TASK="$(node "$MO" task create \
  --title hello \
  --deliverable "打印 hello world" \
  --verify "run:echo hello world" \
  --exec "node $EXECUTOR" \
  --json 2>/dev/null | ask_id)"
run node "$MO" task status "$TASK"

step "4/7 确认（这一步只有人能拍板）"
run node "$MO" task confirm "$TASK"

step "5/7 派单：起执行者 → 收回执 → core 跑验收"
run node "$MO" task dispatch "$TASK"

step "6/7 看结果：状态、验收、事件"
run node "$MO" task status "$TASK"

step "7/7 看账本：一条任务的时间线"
run node "$MO" ledger query --task "$TASK"

printf "\n\033[1m完成\033[0m\n"
printf "项目目录：%s\n" "$PROJECT"
printf "卡片与回执都在 %s/.mo-agent/ 下，可以直接打开看\n" "$PROJECT"
printf "\n清理：rm -rf %s\n" "$TMP"
