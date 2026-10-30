import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { complete, describe } from "./lib/complete.mjs";
import { attachProject } from "./lib/project.mjs";
import { saveCard } from "./lib/store.mjs";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-complete-"));
  const project = path.join(root, "proj");
  fs.mkdirSync(project, { recursive: true });
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.MO_AGENT_HOME = home;
  attachProject(project, { home });
  return { root, project, home };
}

function addTask(project, id, title, status = "draft") {
  saveCard(project, { id, project: "p_test", title, status, created: "2026-10-23T00:00:00.000Z" }, "## 交付物\n\n- x\n");
}

const values = (items) => items.map((entry) => entry.value);

test("顶层命令", () => {
  const ws = workspace();
  assert.deepEqual(values(complete({ cwd: ws.project, words: [""] })), [
    "project", "task", "receipt", "ledger", "doctor", "worker", "skill", "memory", "inbox", "mcp", "agent", "terminal", "daemon", "config", "setup", "watchdog", "completion", "version", "help",
  ]);
});

test("按前缀过滤", () => {
  const ws = workspace();
  assert.deepEqual(values(complete({ cwd: ws.project, words: ["ta"] })), ["task"]);
});

test("子命令与全局选项", () => {
  const ws = workspace();
  const items = values(complete({ cwd: ws.project, words: ["task", ""] }));
  for (const sub of ["create", "confirm", "cancel", "status", "list", "dispatch"]) {
    assert.ok(items.includes(sub), "缺少子命令 " + sub);
  }
  assert.ok(items.includes("--project"));
});

test("半截选项只补选项", () => {
  const ws = workspace();
  assert.deepEqual(values(complete({ cwd: ws.project, words: ["task", "create", "--ti"] })), ["--title", "--timeout"]);
});

test("确认/取消/查看 补任务 id", () => {
  const ws = workspace();
  addTask(ws.project, "t_01A", "甲");
  addTask(ws.project, "t_01B", "乙");
  for (const sub of ["confirm", "cancel", "status"]) {
    const got = values(complete({ cwd: ws.project, words: ["task", sub, ""] }));
    assert.deepEqual(got, ["t_01A", "t_01B"], sub + " 候选不对");
  }
  assert.deepEqual(values(complete({ cwd: ws.project, words: ["receipt", "apply", ""] })), ["t_01A", "t_01B"]);
});

test("--project 补项目名", () => {
  const ws = workspace();
  const got = values(complete({ cwd: ws.project, words: ["task", "list", "--project", ""] }));
  assert.deepEqual(got, ["proj"]);
});

test("没有项目上下文时不给 taskId，只给 flag", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-complete-empty-"));
  process.env.MO_AGENT_HOME = path.join(root, "home");
  fs.mkdirSync(process.env.MO_AGENT_HOME, { recursive: true });
  const got = values(complete({ cwd: root, words: ["task", "confirm", ""] }));
  assert.ok(!got.some((value) => value.startsWith("t_")), "不该凭空给 taskId");
  assert.ok(got.includes("--wait"), "应该仍然给 flag");
});

test("describe 把冒号换成中点", () => {
  assert.equal(describe({ value: "t_1", description: "draft: 标题" }), "t_1:draft· 标题");
  assert.equal(describe({ value: "t_1", description: "" }), "t_1");
});
test("help 的补全：列出所有话题，按前缀过滤", () => {
  const ws = workspace();
  const all = values(complete({ cwd: ws.project, words: ["help", ""] }));
  for (const name of ["task", "memory", "agent", "project", "doctor", "completion", "help"]) {
    assert.ok(all.includes(name), "缺少话题 " + name);
  }
  assert.deepEqual(values(complete({ cwd: ws.project, words: ["help", "t"] })), ["task", "terminal"]);
});

test("每个组都补出 help 子命令", () => {
  const ws = workspace();
  const items = values(complete({ cwd: ws.project, words: ["task", ""] }));
  assert.ok(items.includes("help"), "task 组缺 help 子命令");
});
test("子命令的 flag 只给该子命令自己的", () => {
  const ws = workspace();
  const confirm = values(complete({ cwd: ws.project, words: ["task", "confirm", "--"] }));
  assert.ok(confirm.includes("--wait"));
  assert.ok(confirm.includes("--ttl"));
  assert.ok(!confirm.includes("--title"), "confirm 不该出现 --title");
  assert.ok(!confirm.includes("--deliverable"), "confirm 不该出现 --deliverable");

  const create = values(complete({ cwd: ws.project, words: ["task", "create", ""] }));
  assert.ok(create.includes("--title"));
  assert.ok(!create.includes("--wait"));
});

test("无位置参数时给 flag，而不是空", () => {
  const ws = workspace();
  for (const words of [["ledger", "query", ""], ["agent", "add", ""], ["worker", "add", ""], ["skill", "install", ""], ["inbox", "pull", ""]]) {
    const got = values(complete({ cwd: ws.project, words }));
    assert.ok(got.some((value) => value.startsWith("--")), words.join(" ") + " 应该给 flag");
  }
});

test("枚举值有补全", () => {
  const ws = workspace();
  assert.deepEqual(values(complete({ cwd: ws.project, words: ["memory", "recall", "--scope", ""] })), [
    "preferences",
    "pitfalls",
    "decisions",
  ]);
  assert.deepEqual(values(complete({ cwd: ws.project, words: ["project", "init", "--mode", ""] })), [
    "auto",
    "skill",
    "ref",
    "inline",
  ]);
  assert.ok(values(complete({ cwd: ws.project, words: ["skill", "install", "--target", ""] })).includes("agents"));
});

test("无子命令的组不瞎给 taskId", () => {
  const ws = workspace();
  addTask(ws.project, "t_01A", "甲");
  for (const group of ["doctor", "mcp"]) {
    const got = values(complete({ cwd: ws.project, words: [group, ""] }));
    assert.ok(!got.includes("t_01A"), group + " 不该补 taskId");
    assert.ok(got.includes("--json") || got.includes("--help"), group + " 应该给 flag");
  }
});

test("daemon 的子命令和 flag 能补全", () => {
  const subs = values(complete({ cwd: os.tmpdir(), words: ["daemon", ""] }));
  for (const name of ["start", "stop", "status", "help"]) assert.ok(subs.includes(name), "缺 " + name);

  const flags = values(complete({ cwd: os.tmpdir(), words: ["daemon", "start", "--"] }));
  assert.ok(flags.includes("--port"));
  assert.ok(flags.includes("--foreground"));
});

test("setup 的 flag 有补全，包含 --only / --skip", () => {
  const ws = workspace();
  const got = values(complete({ cwd: ws.project, words: ["setup", "--"] }));
  for (const flag of ["--yes", "--dry-run", "--only", "--skip", "--json"]) {
    assert.ok(got.includes(flag), "缺少 " + flag);
  }
});

test("自由文本 flag 之后不再给候选", () => {
  const ws = workspace();
  assert.deepEqual(values(complete({ cwd: ws.project, words: ["task", "create", "--title", ""] })), []);
});