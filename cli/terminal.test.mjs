import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mo-terminal-")));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}

function run(ws, args, extraEnv = {}) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: ws.root,
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

test("list 列出内置终端", () => {
  const ws = workspace();
  const listed = runJson(ws, ["terminal", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  const names = listed.parsed.terminals.map((item) => item.name);
  for (const name of ["iterm", "terminal", "print", "none"]) assert.ok(names.includes(name), name);
});

test("add --use 设置默认，list 标出来", () => {
  const ws = workspace();
  const added = runJson(ws, ["terminal", "add", "my-tmux", "--command", 'tmux new-window "bash {script}"', "--use"]);
  assert.equal(added.status, 0, added.stderr);

  const listed = runJson(ws, ["terminal", "list"]);
  const mine = listed.parsed.terminals.find((item) => item.name === "my-tmux");
  assert.ok(mine, "应该能列出自定义终端");
  assert.equal(mine.source, "custom");
  assert.equal(mine.default, true);
});

test("模板必须包含 {script} 或 {raw}", () => {
  const ws = workspace();
  const denied = runJson(ws, ["terminal", "add", "bad", "--command", "open -a WezTerm"]);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /E_USAGE/);
});

test("不能覆盖内置名称，也不能删内置", () => {
  const ws = workspace();
  assert.equal(runJson(ws, ["terminal", "add", "iterm", "--command", "x {script}"]).status, 2);
  assert.equal(runJson(ws, ["terminal", "remove", "iterm"]).status, 2);
});

test("use 未知终端报 E_NOT_FOUND", () => {
  const ws = workspace();
  const denied = runJson(ws, ["terminal", "use", "nope"]);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /E_NOT_FOUND/);
});

test("remove 自定义终端，并把默认清空", () => {
  const ws = workspace();
  runJson(ws, ["terminal", "add", "mine", "--command", "sh {script}", "--use"]);
  const removed = runJson(ws, ["terminal", "remove", "mine"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(runJson(ws, ["terminal", "current"]).parsed.current, "");
});

test("默认终端会被派单用上（自定义命令真跑起来）", () => {
  const ws = workspace();
  const project = path.join(ws.root, "proj");
  fs.mkdirSync(project, { recursive: true });
  const marker = path.join(ws.root, "launched.txt");
  const add = runJson(ws, [
    "terminal", "add", "marker",
    "--command", "echo launched > " + JSON.stringify(marker) + " && sh {script}",
    "--use",
  ]);
  assert.equal(add.status, 0, add.stderr);

  run(ws, ["project", "add", "."], { cwd: project });
  run(ws, ["worker", "add", "fake-session", "--command", "echo", "--requires", "echo", "--session"], { cwd: project });
  const created = runJson(ws, [
    "task", "create",
    "--title", "会话",
    "--deliverable", "x",
    "--verify", "run:true",
    "--worker", "fake-session",
  ], { cwd: project });
  const taskId = created.parsed.taskId;
  run(ws, ["task", "confirm", taskId], { cwd: project });
  run(ws, ["task", "approve", taskId, "--yes"], { cwd: project });

  const dispatched = runJson(ws, ["task", "dispatch", taskId], { cwd: project });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(dispatched.parsed.session.terminal, "marker");
  assert.equal(dispatched.parsed.session.reason, "default");
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "launched");
});
