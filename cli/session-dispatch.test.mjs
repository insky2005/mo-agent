import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mo-session-")));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, project, home };
}

function run(ws, args, extraEnv = {}) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: ws.project,
    env: { ...process.env, MO_AGENT_HOME: ws.home, ...extraEnv },
    encoding: "utf8",
  });
}

function runJson(ws, args, extraEnv = {}) {
  const result = run(ws, [...args, "--json"], extraEnv);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

function prepare(ws, worker = "fake-session") {
  run(ws, ["project", "add", "."]);
  run(ws, ["worker", "add", worker, "--command", "echo", "--requires", "echo", "--session"]);
  const created = runJson(ws, [
    "task", "create",
    "--title", "加筛选栏",
    "--deliverable", "tasks.html 有筛选栏",
    "--verify", "run:node -e 0",
    "--worker", worker,
  ]);
  const taskId = created.parsed.taskId;
  run(ws, ["task", "confirm", taskId]);
  run(ws, ["task", "approve", taskId, "--yes"]);
  return taskId;
}

test("会话型 worker：派单写信封 + 脚本，立即返回 running", () => {
  const ws = workspace();
  const taskId = prepare(ws);

  const dispatched = runJson(ws, ["task", "dispatch", taskId], { MO_LAUNCHER: "print", MO_TERMINAL: "iterm" });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.status, "running");
  assert.equal(dispatched.parsed.session.terminal, "print");
  assert.equal(dispatched.parsed.session.launched, false);

  const script = fs.readFileSync(dispatched.parsed.session.script, "utf8");
  const envelope = fs.readFileSync(dispatched.parsed.session.envelope, "utf8");
  const receipt = path.join(ws.project, ".mo-agent", "receipts", taskId + ".json");

  assert.match(script, /exec echo '/);
  assert.ok(script.includes(receipt), "脚本里要写清回执路径");
  assert.ok(script.includes(dispatched.parsed.session.envelope), "提示语要指向信封文件");
  assert.match(envelope, /--- 任务卡 ---/);
  assert.match(envelope, new RegExp(taskId));

  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(status.parsed.status, "running");

  const ledger = runJson(ws, ["ledger", "query", "--task", taskId]);
  const dispatchedEvent = ledger.parsed.events.find((event) => event.type === "task.dispatched");
  assert.equal(dispatchedEvent.payload.assignee, "fake-session");
  assert.equal(dispatchedEvent.payload.session, "iterm");
});

test("没有终端时拒绝派单，且不把卡改成 running", () => {
  const ws = workspace();
  const taskId = prepare(ws);

  const denied = runJson(ws, ["task", "dispatch", taskId], { MO_TERMINAL: "none", MO_LAUNCHER: "" });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /E_NO_TERMINAL/);
  assert.equal(runJson(ws, ["task", "status", taskId]).parsed.status, "confirmed");
});

test("无头 worker 仍然走原来的子进程路径", () => {
  const ws = workspace();
  run(ws, ["project", "add", "."]);
  const created = runJson(ws, [
    "task", "create",
    "--title", "无头",
    "--deliverable", "x",
    "--verify", "run:node -e 0",
    "--exec", "node -e process.exit(0)",
  ]);
  const taskId = created.parsed.taskId;
  run(ws, ["task", "confirm", taskId]);
  run(ws, ["task", "approve", taskId, "--yes"]);

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.parsed.status, "blocked");
  assert.equal(dispatched.parsed.reason, "missing_receipt");
  assert.equal(dispatched.parsed.session, undefined);
});
test("workdir：会话脚本 cd 到子目录，信封仍落在项目根", () => {
  const ws = workspace();
  fs.mkdirSync(path.join(ws.project, "app", "web"), { recursive: true });
  const taskId = prepare(ws); // 复用 worker 注册
  // 直接改卡上的 workdir，避免再建一张
  const cardFile = path.join(ws.project, ".mo-agent", "tasks", taskId + ".md");
  fs.writeFileSync(cardFile, fs.readFileSync(cardFile, "utf8").replace("workdir: .", "workdir: app/web"));

  const dispatched = runJson(ws, ["task", "dispatch", taskId], { MO_LAUNCHER: "print", MO_TERMINAL: "iterm" });
  assert.equal(dispatched.status, 0, dispatched.stderr);

  const script = fs.readFileSync(dispatched.parsed.session.script, "utf8");
  assert.ok(script.includes("cd '" + path.join(ws.project, "app", "web") + "'"), "脚本要 cd 到 workdir");
  assert.ok(
    dispatched.parsed.session.envelope.startsWith(path.join(ws.project, ".mo-agent", "envelopes")),
    "信封仍放项目根",
  );
});

test("workdir 越出项目根：E_SCOPE，卡不变", () => {
  const ws = workspace();
  const taskId = prepare(ws);
  const cardFile = path.join(ws.project, ".mo-agent", "tasks", taskId + ".md");
  fs.writeFileSync(cardFile, fs.readFileSync(cardFile, "utf8").replace("workdir: .", "workdir: ../outside"));

  const denied = runJson(ws, ["task", "dispatch", taskId], { MO_LAUNCHER: "print", MO_TERMINAL: "iterm" });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /E_SCOPE/);
  assert.equal(runJson(ws, ["task", "status", taskId]).parsed.status, "confirmed");
});

test("无头派单也遵守 workdir", () => {
  const ws = workspace();
  fs.mkdirSync(path.join(ws.project, "sub"), { recursive: true });
  fs.writeFileSync(
    path.join(ws.project, "cwd.mjs"),
    [
      'import fs from "node:fs";',
      "fs.writeFileSync(process.env.MO_RECEIPT, JSON.stringify({",
      "  taskId: process.env.MO_TASK_ID, status: \"done\", summary: process.cwd(),",
      '  verify: [{ cmd: "x", exit: 0 }],',
      "}));",
    ].join("\n"),
  );
  run(ws, ["project", "add", "."]);
  const created = runJson(ws, [
    "task", "create",
    "--title", "无头 workdir",
    "--deliverable", "x",
    "--workdir", "sub",
    "--exec", "node ../cwd.mjs",
  ]);
  const taskId = created.parsed.taskId;
  run(ws, ["task", "confirm", taskId]);
  run(ws, ["task", "approve", taskId, "--yes"]);

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.receipt.summary, path.join(ws.project, "sub"));
});
