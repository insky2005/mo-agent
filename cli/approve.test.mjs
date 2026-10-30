import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-approve-"));
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

function prepare(ws) {
  run(ws, ["project", "init", ".", "--no-agent-file"]);
  const created = runJson(ws, ["task", "create", "--title", "加筛选", "--deliverable", "有筛选栏", "--verify", "run:true"]);
  return created.parsed.taskId;
}

test("confirm 只发起请求，卡仍是 draft", () => {
  const ws = workspace();
  const taskId = prepare(ws);

  const requested = runJson(ws, ["task", "confirm", taskId]);
  assert.equal(requested.status, 0, requested.stderr);
  assert.equal(requested.parsed.pending, true);
  assert.match(requested.parsed.requestId, /^a_/);

  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(status.parsed.status, "draft");
  assert.equal(status.parsed.approval.requestId, requested.parsed.requestId);

  const dispatch = run(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatch.status, 1);
  assert.match(dispatch.stderr, /E_NOT_CONFIRMED/);
});

test("approve --yes 才算确认，账本记两步", () => {
  const ws = workspace();
  const taskId = prepare(ws);
  const requested = runJson(ws, ["task", "confirm", taskId]);

  const approved = runJson(ws, ["task", "approve", taskId, "--yes"]);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(approved.parsed.status, "confirmed");

  const ledger = runJson(ws, ["ledger", "query", "--task", taskId]);
  const actors = Object.fromEntries(ledger.parsed.events.map((event) => [event.type, event.actor]));
  assert.equal(actors["task.confirm_requested"], "agent");
  assert.equal(actors["task.confirmed"], "human");

  const requests = runJson(ws, ["task", "requests"]);
  assert.equal(requests.parsed.total, 0);

  const file = path.join(ws.home, "approvals", requested.parsed.requestId + ".json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).status, "approved");

  const again = runJson(ws, ["task", "approve", taskId, "--yes"]);
  assert.equal(again.status, 0);
  assert.equal(again.parsed.alreadyConfirmed, true);
});

test("reject 让卡留在 draft", () => {
  const ws = workspace();
  const taskId = prepare(ws);
  runJson(ws, ["task", "confirm", taskId]);

  const rejected = runJson(ws, ["task", "reject", taskId, "--yes"]);
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(rejected.parsed.rejected, true);

  assert.equal(runJson(ws, ["task", "status", taskId]).parsed.status, "draft");
  const ledger = runJson(ws, ["ledger", "query", "--task", taskId]);
  assert.ok(ledger.parsed.events.some((event) => event.type === "task.confirm_rejected"));
});

test("没有 TTY 又没 --yes → E_FORBIDDEN", () => {
  const ws = workspace();
  const taskId = prepare(ws);
  runJson(ws, ["task", "confirm", taskId]);

  const denied = run(ws, ["task", "approve", taskId]);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /E_FORBIDDEN/);
  assert.equal(runJson(ws, ["task", "status", taskId]).parsed.status, "draft");
});

test("批准前卡片被改 → E_CARD_CHANGED，请求作废", () => {
  const ws = workspace();
  const taskId = prepare(ws);
  const requested = runJson(ws, ["task", "confirm", taskId]);

  const cardFile = path.join(ws.project, ".mo-agent", "tasks", taskId + ".md");
  fs.writeFileSync(cardFile, fs.readFileSync(cardFile, "utf8") + "\n偷偷加一条要求\n");

  const approved = run(ws, ["task", "approve", taskId, "--yes"]);
  assert.equal(approved.status, 1);
  assert.match(approved.stderr, /E_CARD_CHANGED/);
  assert.equal(runJson(ws, ["task", "status", taskId]).parsed.status, "draft");

  const file = path.join(ws.home, "approvals", requested.parsed.requestId + ".json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).status, "stale");
});

test("请求过期后卡变 expired（B4.4）", () => {
  const ws = workspace();
  const taskId = prepare(ws);
  const requested = runJson(ws, ["task", "confirm", taskId]);

  const file = path.join(ws.home, "approvals", requested.parsed.requestId + ".json");
  const request = JSON.parse(fs.readFileSync(file, "utf8"));
  request.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(request));

  const listed = runJson(ws, ["task", "requests"]);
  assert.equal(listed.parsed.total, 0);

  assert.equal(runJson(ws, ["task", "status", taskId]).parsed.status, "expired");
});

test("confirm --wait 超时返回 pending 且退出码 1", () => {
  const ws = workspace();
  const taskId = prepare(ws);
  const waited = runJson(ws, ["task", "confirm", taskId, "--wait", "1s"]);
  assert.equal(waited.status, 1);
  assert.equal(waited.parsed.pending, true);
});
