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

function runJson(ws, args, cwd = ws.project) {
  const result = run(ws, [...args, "--json"], cwd);
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

  // 新流程：confirm 只发起授权请求，批准是独立一步
  const requested = runJson(ws, ["task", "confirm", taskId]);
  assert.equal(requested.status, 0, requested.stderr);
  assert.equal(requested.parsed.pending, true);
  assert.match(requested.parsed.requestId, /^a_/);

  const again = runJson(ws, ["task", "confirm", taskId]);
  assert.equal(again.parsed.requestId, requested.parsed.requestId, "重复 confirm 应复用同一个请求");

  const requests = runJson(ws, ["task", "requests"]);
  assert.equal(requests.parsed.total, 1);

  const confirmed = runJson(ws, ["task", "approve", taskId, "--yes"]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(confirmed.parsed.status, "confirmed");

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.status, "done");
  assert.equal(dispatched.parsed.ok, true);

  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.parsed.status, "done");
  assert.equal(status.parsed.verified, "verified");

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
  confirm(ws, taskId);

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
  confirm(ws, created.parsed.taskId);
  const dispatched = runJson(ws, ["task", "dispatch", created.parsed.taskId]);
  assert.equal(dispatched.parsed.status, "blocked");
  assert.equal(dispatched.parsed.reason, "bad_receipt");
});
test("验收 run:false → blocked + verify_failed，账本留下 task.verify_failed", () => {
  const ws = workspace();
  writeExecutor(ws.project, DONE_EXECUTOR);
  run(ws, ["project", "add", "."]);

  const created = runJson(ws, [
    "task", "create",
    "--title", "故意失败",
    "--deliverable", "x",
    "--verify", "run:false",
    "--exec", "node executor.mjs",
  ]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 1);
  assert.equal(dispatched.parsed.status, "blocked");
  assert.equal(dispatched.parsed.reason, "verify_failed");
  assert.equal(dispatched.parsed.verified, "verify_failed");

  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(status.parsed.status, "blocked");
  assert.equal(status.parsed.verified, "verify_failed");

  const ledger = runJson(ws, ["ledger", "query", "--task", taskId]);
  const types = ledger.parsed.events.map((event) => event.type);
  assert.ok(types.includes("task.verify_failed"), "账本缺少 task.verify_failed，实际：" + types.join(","));
  const failed = ledger.parsed.events.find((event) => event.type === "task.verify_failed");
  assert.equal(failed.payload.ok, false);
  assert.equal(failed.payload.results[0].item, "run: false");
});

test("验收 run:true → done + verified，账本留下 task.verified", () => {
  const ws = workspace();
  writeExecutor(ws.project, DONE_EXECUTOR);
  run(ws, ["project", "add", "."]);

  const created = runJson(ws, [
    "task", "create",
    "--title", "验收通过",
    "--deliverable", "x",
    "--verify", "run:true",
    "--exec", "node executor.mjs",
  ]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.status, "done");
  assert.equal(dispatched.parsed.verified, "verified");

  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(status.parsed.status, "done");
  assert.equal(status.parsed.verified, "verified");

  const ledger = runJson(ws, ["ledger", "query", "--task", taskId]);
  const types = ledger.parsed.events.map((event) => event.type);
  assert.ok(types.includes("task.verified"), "账本缺少 task.verified，实际：" + types.join(","));
});

test("mo task verify 对已 done 的卡重跑验收，失败只改 verified 不改状态", () => {
  const ws = workspace();
  writeExecutor(ws.project, DONE_EXECUTOR);
  run(ws, ["project", "add", "."]);

  const created = runJson(ws, [
    "task", "create",
    "--title", "手动重跑",
    "--deliverable", "x",
    "--verify", "run:true",
    "--exec", "node executor.mjs",
  ]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);
  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.parsed.verified, "verified");

  const passed = runJson(ws, ["task", "verify", taskId]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.parsed.status, "done");
  assert.equal(passed.parsed.verified, "verified");
  assert.equal(passed.parsed.verify.ok, true);
  const passedText = run(ws, ["task", "verify", taskId]);
  assert.equal(passedText.status, 0, passedText.stderr);
  assert.match(passedText.stdout, /验收\s+verified 1\/1/);
  assert.match(passedText.stdout, /run: true/);

  // 把卡上的验收改成必然失败，再重跑：状态保持 done，只把 verified 改成 verify_failed
  const cardText = fs.readFileSync(created.parsed.path, "utf8");
  fs.writeFileSync(created.parsed.path, cardText.replace("run: true", "run: false"));

  const failed = runJson(ws, ["task", "verify", taskId]);
  assert.equal(failed.status, 1);
  assert.equal(failed.parsed.status, "done");
  assert.equal(failed.parsed.verified, "verify_failed");
  const failedText = run(ws, ["task", "verify", taskId]);
  assert.equal(failedText.status, 1);
  assert.match(failedText.stdout, /验收\s+失败 1\/1/);
  assert.match(failedText.stdout, /建议取消或重派/);

  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(status.parsed.status, "done");
  assert.equal(status.parsed.verified, "verify_failed");
});
test("回执可以后补：submit + apply 把 blocked 救回 done", () => {
  const ws = workspace();
  writeExecutor(ws.project, "process.exit(1);");

  run(ws, ["project", "init", ".", "--no-agent-file"]);
  const created = runJson(ws, [
    "task", "create",
    "--title", "x",
    "--deliverable", "y",
    "--verify", "run:true",
    "--exec", "node executor.mjs",
  ]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);

  const first = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(first.parsed.status, "blocked");

  const receipt = { taskId, status: "done", summary: "补交的回执", verify: [{ cmd: "true", exit: 0 }] };
  const file = path.join(ws.project, "receipt.json");
  fs.writeFileSync(file, JSON.stringify(receipt));

  const submitted = runJson(ws, ["receipt", "submit", taskId, "--file", file]);
  assert.equal(submitted.status, 0, submitted.stderr);

  const applied = runJson(ws, ["receipt", "apply", taskId]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.parsed.status, "done");
  assert.equal(applied.parsed.verified, "verified");
});
test("账本记录发起者：cli 动作记 agent，确认记 human", () => {
  const ws = workspace();
  run(ws, ["project", "init", ".", "--no-agent-file"]);

  const created = runJson(ws, ["task", "create", "--title", "x", "--deliverable", "y"]);
  const taskId = created.parsed.taskId;
  const requested = run(ws, ["task", "confirm", taskId]);
  assert.equal(requested.status, 0, requested.stderr);
  const ok = run(ws, ["task", "approve", taskId, "--yes"]);
  assert.equal(ok.status, 0, ok.stderr);

  const ledger = runJson(ws, ["ledger", "query", "--task", taskId]);
  const actors = Object.fromEntries(ledger.parsed.events.map((event) => [event.type, event.actor]));
  assert.equal(actors["task.created"], "agent");
  assert.equal(actors["task.confirm_requested"], "agent");
  assert.equal(actors["task.confirmed"], "human");
});
test("派单会留下完整日志，mo task logs 能读到执行者输出", () => {
  const ws = workspace();
  writeExecutor(ws.project, 'console.log("exec-said-hi");\n' + DONE_EXECUTOR);
  run(ws, ["project", "init", ".", "--no-agent-file"]);

  const created = runJson(ws, ["task", "create", "--title", "log", "--deliverable", "y", "--exec", "node executor.mjs"]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);
  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 0, dispatched.stderr);

  const logs = run(ws, ["task", "logs", taskId]);
  assert.equal(logs.status, 0, logs.stderr);
  assert.match(logs.stdout, /exec-said-hi/);
  assert.match(logs.stdout, /command:  node executor\.mjs/);
  assert.match(logs.stdout, /exit:     0/);
});
function gitRepo(ws, name) {
  const dir = path.join(ws.root, name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  return dir;
}

test("mo project agent 只写文档，不认领项目", () => {
  const ws = workspace();
  const repo = gitRepo(ws, "repo-agent");

  const result = run(ws, ["project", "agent", "--mode", "inline"], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(repo, ".mo-agent", "project.json")), false, "不该创建 project.json");
  assert.match(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /mo task create/);
});

test("只读命令不认领项目，也不写注册表", () => {
  const ws = workspace();
  const repo = gitRepo(ws, "repo-read");

  const result = run(ws, ["task", "list"], repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_PROJECT_UNBOUND/);
  assert.equal(fs.existsSync(path.join(repo, ".mo-agent", "project.json")), false);
  assert.equal(fs.existsSync(path.join(ws.home, "projects.json")), false);
});

test("建卡仍然自动认领（B1.2）", () => {
  const ws = workspace();
  const repo = gitRepo(ws, "repo-create");

  const created = runJson(ws, ["task", "create", "--title", "x", "--deliverable", "y"], repo);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.parsed.taskId, /^t_/);
  assert.equal(fs.existsSync(path.join(repo, ".mo-agent", "project.json")), true);
});
