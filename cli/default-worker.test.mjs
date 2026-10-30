import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mo-default-worker-")));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(project, "exec.mjs"),
    [
      'import fs from "node:fs";',
      "process.stdin.resume();",
      'process.stdin.on("end", () => {',
      "  fs.writeFileSync(process.env.MO_RECEIPT, JSON.stringify({",
      '    taskId: process.env.MO_TASK_ID, status: "done", summary: "ok",',
      '    verify: [{ cmd: "x", exit: 0 }],',
      "  }));",
      "});",
    ].join("\n"),
  );
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

function setup(ws) {
  run(ws, ["project", "add", "."]);
  runJson(ws, ["worker", "add", "fake", "--command", "node exec.mjs", "--requires", "node"]);
}

test("use 设置默认，current 打印；未知名字报错", () => {
  const ws = workspace();
  setup(ws);

  assert.equal(runJson(ws, ["worker", "use", "fake"]).status, 0);
  assert.equal(runJson(ws, ["worker", "current"]).parsed.current, "fake");

  const missing = runJson(ws, ["worker", "use", "nope"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /E_NOT_FOUND/);

  runJson(ws, ["worker", "use", "--unset"]);
  assert.equal(runJson(ws, ["worker", "current"]).parsed.current, "");
});

test("add --use 一步到位，并在 list 里标默认", () => {
  const ws = workspace();
  setup(ws);
  const added = runJson(ws, ["worker", "add", "other", "--command", "node exec.mjs", "--requires", "node", "--use"]);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.parsed.default, true);

  const listed = runJson(ws, ["worker", "list"]);
  assert.equal(listed.parsed.default, "other");
  assert.equal(listed.parsed.workers.find((item) => item.name === "other").default, true);
});

test("assignee: auto 的卡用默认执行者派单", () => {
  const ws = workspace();
  setup(ws);
  runJson(ws, ["worker", "use", "fake"]);

  const created = runJson(ws, ["task", "create", "--title", "自动", "--deliverable", "x", "--verify", "run:node -e 0"]);
  assert.equal(created.status, 0, created.stderr);
  assert.doesNotMatch(created.stderr, /W_NO_EXECUTOR/);

  const taskId = created.parsed.taskId;
  run(ws, ["task", "confirm", taskId]);
  run(ws, ["task", "approve", taskId, "--yes"]);

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.status, "done");
  assert.equal(dispatched.parsed.receipt.summary, "ok");
});

test("没有默认执行者时，建卡告警、派单报 E_NO_EXECUTOR", () => {
  const ws = workspace();
  setup(ws);

  const created = runJson(ws, ["task", "create", "--title", "无执行者", "--deliverable", "x", "--verify", "run:node -e 0"]);
  assert.match(created.stderr, /W_NO_EXECUTOR/);

  const taskId = created.parsed.taskId;
  run(ws, ["task", "confirm", taskId]);
  run(ws, ["task", "approve", taskId, "--yes"]);

  const denied = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /E_NO_EXECUTOR/);
  assert.match(denied.stderr, /mo worker use/);
});

test("项目默认优先于个人默认", () => {
  const ws = workspace();
  setup(ws);
  runJson(ws, ["worker", "use", "fake"]); // 个人默认

  runJson(ws, ["worker", "add", "proj-only", "--command", "node exec.mjs", "--requires", "node", "--project", "--use"]);
  assert.equal(runJson(ws, ["worker", "current"]).parsed.current, "proj-only");
  assert.equal(runJson(ws, ["worker", "current", "--project"]).parsed.current, "proj-only");
});
