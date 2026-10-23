#!/usr/bin/env bash
# 五分钟演示：在临时目录里跑四个场景，不联网、不调模型、不花钱。
#   bash scripts/demo-cli.sh
#
# 1. 正常完成：执行者写合法回执
# 2. 没写回执：blocked(missing_receipt)，不算成功
# 3. 回执非法：blocked(bad_receipt)
# 4. 卡住后换执行者重试：blocked → done
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MO="$ROOT/cli/mo.mjs"
TMP="$(mktemp -d)"
export MO_AGENT_HOME="$TMP/home"
PROJECT="$TMP/demo-project"
mkdir -p "$PROJECT"
cd "$PROJECT"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
note() { printf "  %s\n" "$1"; }
id_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).taskId)}catch{console.log("")}})'; }

cat > ok.mjs <<'JS'
import fs from "node:fs";
import path from "node:path";
fs.mkdirSync(path.dirname(process.env.MO_RECEIPT), { recursive: true });
fs.writeFileSync(process.env.MO_RECEIPT, JSON.stringify({
  taskId: process.env.MO_TASK_ID,
  status: "done",
  summary: "已按卡交付（演示）",
  artifacts: [{ path: "out/result.txt", kind: "file" }],
  verify: [{ cmd: "demo-check", exit: 0 }],
  deviations: [],
  pitfalls: [{ symptom: "hook 路径带空格会静默失效", trigger: "路径含空格", cause: "没加引号", fix: "写入时加双引号" }],
  needs: [],
}, null, 2));
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/result.txt", "hello\n");
console.log("RECEIPT_WRITTEN " + process.env.MO_RECEIPT);
JS

cat > silent.mjs <<'JS'
console.log("我干完了（但没写回执）");
process.exit(0);
JS

cat > bad.mjs <<'JS'
import fs from "node:fs";
fs.writeFileSync(process.env.MO_RECEIPT, JSON.stringify({ taskId: process.env.MO_TASK_ID, status: "done" }));
JS

new_task() {
  node "$MO" task create --title "$1" --deliverable "$2" \
    --verify "check:演示检查通过" --exec "$3" --json | id_of
}

bold "演示：mo 的任务闭环（四个场景，全程本地、不联网）"

bold "准备：登记一个临时项目"
node "$MO" project add . --name demo | sed 's/^/  /'
note "目录：$PROJECT"

bold "场景 1/4：正常完成"
ID1="$(new_task "写一个结果文件" "out/result.txt 存在" "node ok.mjs")"
node "$MO" task confirm "$ID1" >/dev/null
node "$MO" task dispatch "$ID1" 2>/dev/null | sed 's/^/  /'
note "回执：$(ls .mo-agent/receipts/"$ID1".json 2>/dev/null || echo 无)"

bold "场景 2/4：执行者没写回执 → 不算成功"
ID2="$(new_task "假装干完了" "随便" "node silent.mjs")"
node "$MO" task confirm "$ID2" >/dev/null
node "$MO" task dispatch "$ID2" 2>/dev/null | sed 's/^/  /'

bold "场景 3/4：回执不合法 → 也不算成功"
ID3="$(new_task "回执缺验收证据" "随便" "node bad.mjs")"
node "$MO" task confirm "$ID3" >/dev/null
node "$MO" task dispatch "$ID3" 2>/dev/null | sed 's/^/  /'

bold "场景 4/4：卡住后换执行者重试"
note "先失败一次："
node "$MO" task dispatch "$ID2" --exec 'exit 1' 2>/dev/null | sed 's/^/  /'
note "再换回能写回执的执行者："
node "$MO" task dispatch "$ID2" --exec 'node ok.mjs' 2>/dev/null | sed 's/^/  /'

bold "账本（每个任务一条时间线）"
node "$MO" ledger query --days 1 --json | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const events = JSON.parse(s).events;
  const byTask = new Map();
  for (const e of events) {
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e.type);
  }
  for (const [task, types] of byTask) console.log("  " + task.slice(0, 12) + "…  " + types.join(" → "));
});
'

bold "任务一览"
node "$MO" task list | sed 's/^/  /'

bold "产物"
note "项目：$PROJECT"
find .mo-agent -type f | sed 's/^/  /'
note "演示目录（可删）：$TMP"