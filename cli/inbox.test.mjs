import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

/** 新流程：confirm 只发起请求，批准是另一步（测试里用 --yes 跳过 TTY） */
function confirm(ws, taskId) {
  run(ws, ["task", "confirm", taskId]);
  return run(ws, ["task", "approve", taskId, "--yes"]);
}


function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-inbox-"));
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

const DONE_EXECUTOR = [
  'import fs from "node:fs";',
  "fs.writeFileSync(",
  "  process.env.MO_RECEIPT,",
  '  JSON.stringify({ taskId: process.env.MO_TASK_ID, status: "done", summary: "跑完了", verify: [{ cmd: "x", exit: 0 }] }),',
  ");",
  'console.log("RECEIPT_WRITTEN " + process.env.MO_RECEIPT);',
].join("\n");

function prepare(ws, executor, title = "加筛选") {
  fs.writeFileSync(path.join(ws.project, "executor.mjs"), executor);
  runJson(ws, ["project", "add", "."]);
  const created = runJson(ws, [
    "task", "create",
    "--title", title,
    "--deliverable", "能用",
    "--verify", "run:node -e 0",
    "--exec", "node executor.mjs",
  ]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);
  return taskId;
}

test("空收件箱 → 没有新消息", () => {
  const ws = workspace();
  const result = runJson(ws, ["inbox", "pull"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.parsed.count, 0);
  assert.deepEqual(result.parsed.items, []);
});

test("任务 done 后 pull 拿到一条，第二次为空（拉取即归档）", () => {
  const ws = workspace();
  const taskId = prepare(ws, DONE_EXECUTOR);
  runJson(ws, ["task", "dispatch", taskId]);

  const first = runJson(ws, ["inbox", "pull"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.parsed.count, 1);
  assert.equal(first.parsed.archived, 1);
  assert.equal(first.parsed.items[0].taskId, taskId);
  assert.equal(first.parsed.items[0].type, "task.done");
  assert.equal(first.parsed.items[0].status, "done");
  assert.equal(first.parsed.items[0].title, "加筛选");
  assert.equal(first.parsed.items[0].summary, "跑完了");

  const second = runJson(ws, ["inbox", "pull"]);
  assert.equal(second.parsed.count, 0);
});

test("--peek 不归档，可以反复看", () => {
  const ws = workspace();
  const taskId = prepare(ws, DONE_EXECUTOR);
  runJson(ws, ["task", "dispatch", taskId]);

  const peeked = runJson(ws, ["inbox", "pull", "--peek"]);
  assert.equal(peeked.parsed.count, 1);
  assert.equal(peeked.parsed.archived, 0);

  const again = runJson(ws, ["inbox", "pull"]);
  assert.equal(again.parsed.count, 1);
  assert.equal(again.parsed.archived, 1);
});

test("blocked 也进收件箱，带原因", () => {
  const ws = workspace();
  const taskId = prepare(ws, "process.exit(0);");
  runJson(ws, ["task", "dispatch", taskId]);

  const pulled = runJson(ws, ["inbox", "pull"]);
  assert.equal(pulled.parsed.count, 1);
  assert.equal(pulled.parsed.items[0].status, "blocked");
  assert.equal(pulled.parsed.items[0].reason, "missing_receipt");
});

test("重复派单同一任务不刷屏：只留一条", () => {
  const ws = workspace();
  const taskId = prepare(ws, "process.exit(0);");
  runJson(ws, ["task", "dispatch", taskId]);
  runJson(ws, ["task", "dispatch", taskId]);

  const pulled = runJson(ws, ["inbox", "pull"]);
  assert.equal(pulled.parsed.count, 1);
  assert.equal(pulled.parsed.items[0].taskId, taskId);
});

test("--task 过滤", () => {
  const ws = workspace();
  const first = prepare(ws, DONE_EXECUTOR, "任务一");
  runJson(ws, ["task", "dispatch", first]);
  const second = prepare(ws, DONE_EXECUTOR, "任务二");
  runJson(ws, ["task", "dispatch", second]);

  const filtered = runJson(ws, ["inbox", "pull", "--task", second]);
  assert.equal(filtered.parsed.count, 1);
  assert.equal(filtered.parsed.items[0].taskId, second);

  const rest = runJson(ws, ["inbox", "pull"]);
  assert.equal(rest.parsed.count, 1);
  assert.equal(rest.parsed.items[0].taskId, first);
});
test("inbox pull --wait 到点没有消息：timedOut 且不算失败", () => {
  const ws = workspace();
  const started = Date.now();
  const waited = runJson(ws, ["inbox", "pull", "--wait", "1s"]);
  const elapsed = Date.now() - started;
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.parsed.count, 0);
  assert.equal(waited.parsed.timedOut, true);
  assert.ok(elapsed >= 800, "应该真的等了一会儿，实际 " + elapsed + "ms");
});

test("inbox pull --wait 有消息时立刻返回", () => {
  const ws = workspace();
  const taskId = prepare(ws, DONE_EXECUTOR);
  runJson(ws, ["task", "dispatch", taskId]);

  const pulled = runJson(ws, ["inbox", "pull", "--wait", "5s"]);
  assert.equal(pulled.parsed.count, 1);
  assert.equal(pulled.parsed.timedOut, false);
});

test("--from 写进卡片与账本，缺省回落到环境变量", () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.project, "executor.mjs"), DONE_EXECUTOR);
  runJson(ws, ["project", "add", "."]);

  const created = runJson(ws, [
    "task", "create",
    "--title", "带来源",
    "--deliverable", "x",
    "--exec", "node executor.mjs",
    "--from", "claude-code",
  ]);
  const taskId = created.parsed.taskId;
  const card = fs.readFileSync(path.join(ws.project, ".mo-agent", "tasks", taskId + ".md"), "utf8");
  assert.match(card, /from: claude-code/);

  const ledger = runJson(ws, ["ledger", "query", "--task", taskId]);
  const createdEvent = ledger.parsed.events.find((event) => event.type === "task.created");
  assert.equal(createdEvent.payload.from, "claude-code");
});
