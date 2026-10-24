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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-candidates-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, project, home };
}

function run(ws, args, extra = {}) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: ws.project,
    env: { ...process.env, MO_AGENT_HOME: ws.home },
    encoding: "utf8",
    ...extra,
  });
}

function runJson(ws, args, extra = {}) {
  const result = run(ws, [...args, "--json"], extra);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

const knowledge = (ws, ...parts) => path.join(ws.home, "knowledge", ...parts);

test("propose → candidates → accept：进知识库并可按关键词召回", () => {
  const ws = workspace();
  runJson(ws, ["memory", "init"]);
  runJson(ws, ["project", "add", "."]);

  const proposed = runJson(ws, [
    "memory", "propose",
    "--scope", "pitfalls",
    "--title", "派单超时先看日志",
    "--trigger", "派单",
    "--trigger", "超时",
    "--body", "先看 mo task logs，再决定是否重试。",
  ]);
  assert.equal(proposed.status, 0, proposed.stderr);
  assert.match(proposed.parsed.id, /^c_/);
  assert.equal(proposed.parsed.conflict, null);

  const listed = runJson(ws, ["memory", "candidates"]);
  assert.equal(listed.parsed.total, 1);
  assert.equal(listed.parsed.candidates[0].title, "派单超时先看日志");

  const accepted = runJson(ws, ["memory", "accept", proposed.parsed.id]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.parsed.ok, true);
  assert.equal(fs.existsSync(accepted.parsed.file), true);

  const recalled = runJson(ws, ["memory", "recall", "超时"]);
  assert.ok(recalled.parsed.matched.some((entry) => entry.title === "派单超时先看日志"));

  const after = runJson(ws, ["memory", "candidates"]);
  assert.equal(after.parsed.total, 0);

  const ledger = runJson(ws, ["ledger", "query"]);
  const types = ledger.parsed.events.map((event) => event.type);
  assert.ok(types.includes("memory.proposed"), types.join(","));
  assert.ok(types.includes("memory.accepted"), types.join(","));
});

test("propose 也吃 stdin 的 JSON", () => {
  const ws = workspace();
  runJson(ws, ["memory", "init"]);
  const payload = JSON.stringify({ scope: "preferences", title: "先问再做", trigger: ["删除", "修改"], body: "改动前先说明。" });
  const proposed = runJson(ws, ["memory", "propose", "--file", "-"], { input: payload });
  assert.equal(proposed.status, 0, proposed.stderr);

  const accepted = runJson(ws, ["memory", "accept", proposed.parsed.id]);
  assert.equal(accepted.status, 0, accepted.stderr);

  const text = fs.readFileSync(knowledge(ws, "preferences.md"), "utf8");
  assert.match(text, /## 先问再做/);
  assert.match(text, /trigger: 删除, 修改/);
});

test("缺触发条件 → E_MEMORY_INVALID", () => {
  const ws = workspace();
  runJson(ws, ["memory", "init"]);
  const proposed = runJson(ws, ["memory", "propose", "--title", "只有标题", "--body", "没有触发条件"]);
  assert.equal(proposed.status, 1);
  assert.match(proposed.stderr, /E_MEMORY_INVALID/);
  assert.equal(runJson(ws, ["memory", "candidates"]).parsed.total, 0);
});

test("冲突：propose 记警告，accept 拒写（B10.4）", () => {
  const ws = workspace();
  runJson(ws, ["memory", "init"]);
  fs.writeFileSync(
    knowledge(ws, "pitfalls", "old.md"),
    "## 派单超时先看日志\n\n- trigger: 派单\n\n旧内容。\n",
    "utf8",
  );

  const proposed = runJson(ws, ["memory", "propose", "--title", "派单超时先看日志", "--trigger", "派单", "--body", "新内容"]);
  assert.equal(proposed.status, 0, proposed.stderr);
  assert.equal(proposed.parsed.conflict.kind, "same-title");
  assert.match(proposed.stderr, /W_MEMORY_CONFLICT/);

  const accepted = runJson(ws, ["memory", "accept", proposed.parsed.id]);
  assert.equal(accepted.status, 1);
  assert.match(accepted.stderr, /E_MEMORY_CONFLICT/);
  assert.match(accepted.stderr, /派单超时先看日志/);

  const old = fs.readFileSync(knowledge(ws, "pitfalls", "old.md"), "utf8");
  assert.match(old, /旧内容/);
  assert.equal(runJson(ws, ["memory", "candidates"]).parsed.total, 1);

  const rejected = runJson(ws, ["memory", "reject", proposed.parsed.id]);
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(runJson(ws, ["memory", "candidates"]).parsed.total, 0);
});

test("同一条候选重复提交只留一份", () => {
  const ws = workspace();
  runJson(ws, ["memory", "init"]);
  const first = runJson(ws, ["memory", "propose", "--title", "x", "--trigger", "a", "--body", "b"]);
  const second = runJson(ws, ["memory", "propose", "--title", "x", "--trigger", "a", "--body", "b"]);
  assert.equal(second.status, 0);
  assert.equal(second.parsed.duplicate, true);
  assert.equal(second.parsed.id, first.parsed.id);
  assert.equal(runJson(ws, ["memory", "candidates"]).parsed.total, 1);
});

const PITFALL_EXECUTOR = [
  'import fs from "node:fs";',
  "fs.writeFileSync(",
  "  process.env.MO_RECEIPT,",
  "  JSON.stringify({",
  '    taskId: process.env.MO_TASK_ID,',
  '    status: "done",',
  '    summary: "ok",',
  '    verify: [{ cmd: "x", exit: 0 }],',
  "    pitfalls: [",
  '      { symptom: "回执写晚了", trigger: "回执", cause: "执行者先跑测试", fix: "先写回执再收尾" },',
  '      { symptom: "没写触发条件", trigger: "", cause: "忘了", fix: "补上" },',
  "    ],",
  "  }),",
  ");",
].join("\n");

test("B10.1：回执带 pitfalls 自动生成候选，缺触发条件的拒收", () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.project, "executor.mjs"), PITFALL_EXECUTOR);
  runJson(ws, ["memory", "init"]);
  runJson(ws, ["project", "add", "."]);

  const created = runJson(ws, [
    "task", "create",
    "--title", "跑一遍",
    "--deliverable", "y",
    "--verify", "run:node -e 0",
    "--exec", "node executor.mjs",
  ]);
  const taskId = created.parsed.taskId;
  confirm(ws, taskId);

  const dispatched = runJson(ws, ["task", "dispatch", taskId]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.candidates.length, 1);
  assert.match(dispatched.stderr, /W_MEMORY_INVALID/);

  const listed = runJson(ws, ["memory", "candidates"]);
  assert.equal(listed.parsed.total, 1);
  assert.equal(listed.parsed.candidates[0].title, "回执写晚了");
  assert.equal(listed.parsed.candidates[0].source, "receipt");
  assert.equal(listed.parsed.candidates[0].taskId, taskId);

  const accepted = runJson(ws, ["memory", "accept", listed.parsed.candidates[0].id]);
  assert.equal(accepted.status, 0, accepted.stderr);
  const recalled = runJson(ws, ["memory", "recall", "回执"]);
  assert.ok(recalled.parsed.matched.some((entry) => entry.title === "回执写晚了"));
});
