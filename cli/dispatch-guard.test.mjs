import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * running 不重复派单：卡在跑的时候再 dispatch 必须被拒绝，
 * 否则两个执行者会往同一个 \$MO_RECEIPT 里写。
 */

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-dispatch-guard-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, project, home };
}

function run(ws, args) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: ws.project,
    env: { ...process.env, MO_AGENT_HOME: ws.home },
    encoding: "utf8",
  });
}

function runJson(ws, args) {
  const result = run(ws, [...args, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

function cardFile(ws, taskId) {
  return path.join(ws.project, ".mo-agent", "tasks", taskId + ".md");
}

/** 建卡 → 确认 → 批准 → 把状态改成 running（模拟执行者正在跑） */
function runningCard(ws) {
  runJson(ws, ["project", "init", ".", "--no-agent-file"]);
  const created = runJson(ws, [
    "task", "create",
    "--title", "正在跑的卡",
    "--deliverable", "x",
    "--exec", "node -e 0",
  ]);
  const taskId = created.parsed.taskId;
  runJson(ws, ["task", "confirm", taskId]);
  runJson(ws, ["task", "approve", taskId, "--yes"]);
  const file = cardFile(ws, taskId);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /status: confirmed/);
  fs.writeFileSync(file, text.replace("status: confirmed", "status: running"));
  return taskId;
}

test("running 状态下再派单被拒绝，并提示 --force", () => {
  const ws = workspace();
  const taskId = runningCard(ws);

  const again = run(ws, ["task", "dispatch", taskId]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /E_ALREADY_RUNNING/);
  assert.match(again.stderr, /--force/);

  // 卡片没被改动，仍停在 running
  assert.match(fs.readFileSync(cardFile(ws, taskId), "utf8"), /status: running/);
});

test("--force 可以强行再派一次", () => {
  const ws = workspace();
  const taskId = runningCard(ws);

  const forced = run(ws, ["task", "dispatch", taskId, "--force"]);
  // 执行者不写回执 → blocked(missing_receipt)，重点是它真的跑了
  assert.match(forced.stdout, /缺失|missing_receipt/);
  assert.match(fs.readFileSync(cardFile(ws, taskId), "utf8"), /status: blocked/);
});
