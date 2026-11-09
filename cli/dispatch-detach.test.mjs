import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** dispatch --detach：立即返回，结果晚点从 status / inbox 收。 */

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-detach-"));
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

function confirmedCard(ws) {
  runJson(ws, ["project", "init", ".", "--no-agent-file"]);
  const created = runJson(ws, [
    "task", "create",
    "--title", "后台跑",
    "--deliverable", "x",
    "--exec", "node -e 0",
  ]);
  const taskId = created.parsed.taskId;
  runJson(ws, ["task", "confirm", taskId]);
  runJson(ws, ["task", "approve", taskId, "--yes"]);
  return taskId;
}

function waitForStatus(ws, taskId, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = fs.readFileSync(cardFile(ws, taskId), "utf8");
    if (new RegExp("status: " + expected).test(text)) return true;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},50)"]);
  }
  return false;
}

test("--detach 立即返回，后台跑完把卡推进到 blocked", () => {
  const ws = workspace();
  const taskId = confirmedCard(ws);

  const started = Date.now();
  const result = runJson(ws, ["task", "dispatch", taskId, "--detach"]);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.parsed.detached, true);
  assert.ok(result.parsed.pid, "应该给出后台进程 pid");
  assert.ok(elapsed < 3000, "不该同步等执行者跑完，实际 " + elapsed + "ms");

  // 执行者不写回执 → 最终是 blocked(missing_receipt)
  assert.ok(waitForStatus(ws, taskId, "blocked"), "后台任务没有推进状态");
  const pulled = runJson(ws, ["inbox", "pull", "--task", taskId]);
  assert.equal(pulled.parsed.items[0].reason, "missing_receipt");
});

test("已 dispatched 的卡不能再 detach（占位防止起两个执行者）", () => {
  const ws = workspace();
  const taskId = confirmedCard(ws);
  const file = cardFile(ws, taskId);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("status: confirmed", "status: dispatched"));

  const again = run(ws, ["task", "dispatch", taskId, "--detach"]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /E_NOT_CONFIRMED/);
});

test("draft 的卡 --detach 也会被状态机挡住", () => {
  const ws = workspace();
  runJson(ws, ["project", "init", ".", "--no-agent-file"]);
  const created = runJson(ws, ["task", "create", "--title", "草稿", "--deliverable", "x", "--exec", "node -e 0"]);
  const again = run(ws, ["task", "dispatch", created.parsed.taskId, "--detach"]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /E_NOT_CONFIRMED/);
});

// ---- create 的「批准并派单」一步到位（C4）----

test("approveAndDetach：一次完成确认、批准与后台派单", async () => {
  const { approveAndDetach } = await import("./commands/task.mjs");
  const ws = workspace();
  runJson(ws, ["project", "init", ".", "--no-agent-file"]);
  const created = runJson(ws, ["task", "create", "--title", "合并", "--deliverable", "x", "--exec", "node -e 0", "--no-prompt"]);
  const taskId = created.parsed.taskId;
  assert.match(fs.readFileSync(cardFile(ws, taskId), "utf8"), /status: draft/);

  // detach 会 spawn 一个子进程，它继承 process.env；测试里必须把 home 也放进环境，
  // 否则子进程会去真实的 ~/.mo-agent 找账本与请求。
  const previousHome = process.env.MO_AGENT_HOME;
  process.env.MO_AGENT_HOME = ws.home;
  let code;
  try {
    code = approveAndDetach({
      args: { positional: [], options: {} },
      home: ws.home,
      root: ws.project,
      taskId,
      chosen: null,
    });
  } finally {
    if (previousHome === undefined) delete process.env.MO_AGENT_HOME;
    else process.env.MO_AGENT_HOME = previousHome;
  }
  assert.equal(code, 0);
  const text = fs.readFileSync(cardFile(ws, taskId), "utf8");
  assert.match(text, /status: (dispatched|running|blocked)/, "应该已经越过 confirmed");
  assert.ok(waitForStatus(ws, taskId, "blocked"), "后台执行者应该跑完并落 blocked（无回执）");
});
