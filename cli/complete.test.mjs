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
    "project", "task", "receipt", "ledger", "doctor", "worker", "skill", "memory", "inbox", "completion", "help",
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

test("没有项目上下文时安静返回空", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-complete-empty-"));
  process.env.MO_AGENT_HOME = path.join(root, "home");
  fs.mkdirSync(process.env.MO_AGENT_HOME, { recursive: true });
  assert.deepEqual(complete({ cwd: root, words: ["task", "confirm", ""] }), []);
});

test("describe 把冒号换成中点", () => {
  assert.equal(describe({ value: "t_1", description: "draft: 标题" }), "t_1:draft· 标题");
  assert.equal(describe({ value: "t_1", description: "" }), "t_1");
});