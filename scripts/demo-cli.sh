#!/usr/bin/env bash
# 五分钟演示：在临时目录里跑完 建卡 → 确认 → 派单 → done → 账本。
# 用假执行者，不调用任何模型，不花钱。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MO="$ROOT/cli/mo.mjs"
TMP="$(mktemp -d)"
export MO_AGENT_HOME="$TMP/home"
PROJECT="$TMP/demo-project"
mkdir -p "$PROJECT"
cd "$PROJECT"

cat > executor.mjs <<'JS'
import fs from "node:fs";
import path from "node:path";
const receipt = {
  taskId: process.env.MO_TASK_ID,
  status: "done",
  summary: "假执行者：已按卡交付（演示用）",
  artifacts: [{ path: "out/result.txt", kind: "file" }],
  verify: [{ cmd: "fake-check", exit: 0 }],
  deviations: [],
  pitfalls: [{ symptom: "hook 路径带空格会静默失效", trigger: "配置路径含空格", cause: "未加引号", fix: "写入时始终加双引号" }],
  needs: [],
};
fs.mkdirSync(path.dirname(process.env.MO_RECEIPT), { recursive: true });
fs.writeFileSync(process.env.MO_RECEIPT, JSON.stringify(receipt, null, 2));
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/result.txt", "hello\n");
console.log("RECEIPT_WRITTEN " + process.env.MO_RECEIPT);
JS

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }

say "1/5 登记项目"
node "$MO" project add . --name demo

say "2/5 建卡"
ID="$(node "$MO" task create \
  --title "演示：给页面加一个按钮" \
  --deliverable "out/result.txt 存在" \
  --verify "check:out/result.txt 存在" \
  --boundary "不要改后端" \
  --exec "node executor.mjs" \
  --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).taskId))')"
echo "taskId: $ID"

say "3/5 确认（确认权属于人）"
node "$MO" task confirm "$ID"

say "4/5 派单"
node "$MO" task dispatch "$ID"

say "5/5 状态与账本"
node "$MO" task status "$ID"
node "$MO" ledger query --task "$ID"

say "产物"
echo "项目目录: $PROJECT"
find .mo-agent -type f | sort
echo
echo "演示目录（可删）: $TMP"
