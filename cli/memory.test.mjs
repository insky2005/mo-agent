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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-memory-"));
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

const ENVELOPE_EXECUTOR = [
  'import fs from "node:fs";',
  "const chunks = [];",
  'process.stdin.on("data", (chunk) => chunks.push(chunk));',
  'process.stdin.on("end", () => {',
  '  fs.writeFileSync("envelope.txt", Buffer.concat(chunks).toString("utf8"));',
  "  fs.writeFileSync(",
  "    process.env.MO_RECEIPT,",
  '    JSON.stringify({ taskId: process.env.MO_TASK_ID, status: "done", summary: "ok", verify: [{ cmd: "x", exit: 0 }] }),',
  "  );",
  '  console.log("RECEIPT_WRITTEN " + process.env.MO_RECEIPT);',
  "});",
].join("\n");

function writePreferences(ws, text) {
  fs.writeFileSync(path.join(ws.home, "knowledge", "preferences.md"), text, "utf8");
}

test("memory init 建骨架且幂等", () => {
  const ws = workspace();
  const first = runJson(ws, ["memory", "init"]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.parsed.created.includes("README.md"));
  assert.ok(first.parsed.created.includes("pitfalls/_template.md"));

  const second = runJson(ws, ["memory", "init"]);
  assert.equal(second.status, 0);
  assert.deepEqual(second.parsed.created, []);
});

test("memory list 只列条目，模板与 README 不参与", () => {
  const ws = workspace();
  runJson(ws, ["memory", "init"]);
  writePreferences(ws, "# 偏好\n\n## 结论先行\n\n先给结论。\n\n## 少用感叹号\n\n别浮夸。\n");

  const listed = runJson(ws, ["memory", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.parsed.total, 2);
  assert.deepEqual(listed.parsed.entries.map((entry) => entry.title), ["结论先行", "少用感叹号"]);
});

test("memory recall 命中并排序，支持 scope 过滤", () => {
  const ws = workspace();
  runJson(ws, ["memory", "init"]);
  writePreferences(ws, "## 派单前先问\n\n- trigger: 派单\n\n别自作主张。\n");
  fs.writeFileSync(
    path.join(ws.home, "knowledge", "pitfalls", "timeout.md"),
    "## 派单超时不要猛重试\n\n- trigger: 派单, 超时\n\n先看 logs。\n",
    "utf8",
  );

  const all = runJson(ws, ["memory", "recall", "派单", "超时"]);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.parsed.matched[0].id, "pitfalls:timeout#派单超时不要猛重试");

  const scoped = runJson(ws, ["memory", "recall", "派单", "--scope", "preferences"]);
  assert.deepEqual(scoped.parsed.matched.map((entry) => entry.scope), ["preferences"]);

  const empty = runJson(ws, ["memory", "list"]);
  assert.equal(empty.parsed.total, 2);
});

test("memory recall 缺查询词 → E_USAGE", () => {
  const ws = workspace();
  const result = run(ws, ["memory", "recall"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_USAGE/);
});

test("MO_AGENT_KNOWLEDGE 指到不存在的路径 → E_KNOWLEDGE_UNAVAILABLE", () => {
  const ws = workspace();
  const result = run(ws, ["memory", "recall", "派单"], { MO_AGENT_KNOWLEDGE: path.join(ws.root, "nope") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_KNOWLEDGE_UNAVAILABLE/);
});

test("知识库没初始化时 list 不报错，并提示 init", () => {
  const ws = workspace();
  const result = run(ws, ["memory", "list"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /memory init/);
});

test("派单信封注入命中的知识", () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.project, "executor.mjs"), ENVELOPE_EXECUTOR);
  runJson(ws, ["memory", "init"]);
  writePreferences(ws, "## 先问再做\n\n- trigger: 删除, 修改\n\n改动前先说明。\n");
  fs.writeFileSync(
    path.join(ws.home, "knowledge", "pitfalls", "receipt.md"),
    "## 回执超时先看日志\n\n- trigger: 回执, 超时\n\n不要直接重试。\n",
    "utf8",
  );

  runJson(ws, ["project", "add", "."]);
  const created = runJson(ws, [
    "task", "create",
    "--title", "回执超时排查",
    "--deliverable", "日志里能找到原因",
    "--verify", "run:node -e 0",
    "--exec", "node executor.mjs",
  ]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.knowledge.ok, true);
  assert.deepEqual(dispatched.parsed.knowledge.ids, ["pitfalls:receipt#回执超时先看日志"]);

  const envelope = fs.readFileSync(path.join(ws.project, "envelope.txt"), "utf8");
  assert.match(envelope, /## 卡片附带的知识（自动注入）/);
  assert.match(envelope, /回执超时先看日志/);
  assert.match(envelope, /不要直接重试/);
  assert.doesNotMatch(envelope, /先问再做/);
});

test("知识库读不了也不挡住派单，但要吵一声", () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.project, "executor.mjs"), ENVELOPE_EXECUTOR);
  runJson(ws, ["project", "add", "."]);
  const created = runJson(ws, [
    "task", "create",
    "--title", "x",
    "--deliverable", "y",
    "--verify", "run:node -e 0",
    "--exec", "node executor.mjs",
  ]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);

  const dispatched = runJson(ws, ["task", "dispatch", taskId], {
    MO_AGENT_KNOWLEDGE: path.join(ws.root, "missing"),
  });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.knowledge.ok, false);
  assert.match(dispatched.stderr, /W_KNOWLEDGE_UNAVAILABLE/);

  const envelope = fs.readFileSync(path.join(ws.project, "envelope.txt"), "utf8");
  assert.doesNotMatch(envelope, /卡片附带的知识/);
});
