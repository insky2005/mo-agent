import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-cli-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, project, home };
}

function run(ws, args, cwd = ws.project) {
  const result = spawnSync(process.execPath, [MO, ...args], {
    cwd,
    env: { ...process.env, MO_AGENT_HOME: ws.home },
    encoding: "utf8",
  });
  return result;
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

function writeExecutor(project, body) {
  const file = path.join(project, "executor.mjs");
  fs.writeFileSync(file, body);
  return file;
}

const DONE_EXECUTOR = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'const file = process.env.MO_RECEIPT;',
  'fs.mkdirSync(path.dirname(file), { recursive: true });',
  "fs.writeFileSync(file, JSON.stringify({",
  '  taskId: process.env.MO_TASK_ID,',
  '  status: "done",',
  '  summary: "fake executor ok",',
  '  artifacts: [{ path: "out.txt", kind: "file" }],',
  '  verify: [{ cmd: "fake check", exit: 0 }],',
  "}, null, 2));",
  'console.log("RECEIPT_WRITTEN " + file);',
].join("\n");

test("建卡 → 确认 → 派单 → done，账本可查", () => {
  const ws = workspace();
  writeExecutor(ws.project, DONE_EXECUTOR);

  const added = runJson(ws, ["project", "add", "."]);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.parsed.ok, true);
  assert.match(added.parsed.id, /^p_/);

  const created = runJson(ws, [
    "task", "create",
    "--title", "加筛选",
    "--deliverable", "app/web/tasks.html 有筛选栏",
    "--verify", "run:node -e 0",
    "--exec", "node executor.mjs",
  ]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.parsed.taskId, /^t_/);
  assert.equal(created.parsed.status, "draft");

  const taskId = created.parsed.taskId;
  assert.match(created.parsed.path, /\.mo-agent\/tasks\//);

  const confirmed = runJson(ws, ["task", "confirm", taskId]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(confirmed.parsed.status, "confirmed");

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.status, "done");
  assert.equal(dispatched.parsed.ok, true);

  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.parsed.status, "done");
  assert.equal(status.parsed.verified, "unverified");

  const receiptFile = path.join(ws.project, ".mo-agent", "receipts", taskId + ".json");
  assert.equal(fs.existsSync(receiptFile), true);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(receipt.taskId, taskId);

  const cardText = fs.readFileSync(created.parsed.path, "utf8");
  assert.match(cardText, /status: done/);

  const ledger = runJson(ws, ["ledger", "query", "--task", taskId]);
  assert.equal(ledger.status, 0, ledger.stderr);
  const types = ledger.parsed.events.map((event) => event.type);
  for (const expected of ["task.created", "task.confirmed", "task.dispatched", "receipt.received", "task.completed"]) {
    assert.ok(types.includes(expected), "账本缺少 " + expected + "，实际：" + types.join(","));
  }
});

test("执行者没写回执 → blocked(missing_receipt)，退出码 1", () => {
  const ws = workspace();
  writeExecutor(ws.project, "process.exit(0);");

  run(ws, ["project", "add", "."]);
  const created = runJson(ws, ["task", "create", "--title", "x", "--deliverable", "y", "--exec", "node executor.mjs"]);
  const taskId = created.parsed.taskId;
  run(ws, ["task", "confirm", taskId]);

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 1);
  assert.equal(dispatched.parsed.status, "blocked");
  assert.equal(dispatched.parsed.reason, "missing_receipt");

  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(status.parsed.status, "blocked");
});

test("未确认就派单 → E_NOT_CONFIRMED", () => {
  const ws = workspace();
  run(ws, ["project", "add", "."]);
  const created = runJson(ws, ["task", "create", "--title", "x", "--deliverable", "y"]);
  const result = run(ws, ["task", "dispatch", created.parsed.taskId]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_NOT_CONFIRMED/);
});

test("没有项目上下文 → E_PROJECT_UNBOUND", () => {
  const ws = workspace();
  const outside = path.join(ws.root, "loose");
  fs.mkdirSync(outside, { recursive: true });
  const result = run(ws, ["task", "create", "--title", "x", "--deliverable", "y"], outside);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_PROJECT_UNBOUND/);
});

test("回执不合法 → blocked(bad_receipt)", () => {
  const ws = workspace();
  writeExecutor(ws.project, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const file = process.env.MO_RECEIPT;",
    'fs.mkdirSync(path.dirname(file), { recursive: true });',
    "fs.writeFileSync(file, JSON.stringify({ taskId: process.env.MO_TASK_ID, status: \"done\" }));",
  ].join("\n"));

  run(ws, ["project", "add", "."]);
  const created = runJson(ws, ["task", "create", "--title", "x", "--deliverable", "y", "--exec", "node executor.mjs"]);
  run(ws, ["task", "confirm", created.parsed.taskId]);
  const dispatched = runJson(ws, ["task", "dispatch", created.parsed.taskId]);
  assert.equal(dispatched.parsed.status, "blocked");
  assert.equal(dispatched.parsed.reason, "bad_receipt");
});
