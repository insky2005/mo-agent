import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-help-"));
  return dir;
}

function run(args) {
  return spawnSync(process.execPath, [MO, ...args], {
    env: { ...process.env, MO_AGENT_HOME: home() },
    encoding: "utf8",
  });
}

test("mo help 默认只给一条主路径，不超过 12 行", () => {
  const result = run(["help"]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.ok(lines.length <= 12, "首屏太长：" + lines.length + " 行");
  assert.match(result.stdout, /mo setup/);
  assert.match(result.stdout, /mo task create/);
  assert.match(result.stdout, /mo task show <id>/);
  assert.match(result.stdout, /mo serve start/);
  assert.match(result.stdout, /mo connect describe/);
  assert.match(result.stdout, /mo inbox pull/);
  assert.match(result.stdout, /mo help --all/);
  assert.match(result.stdout, /mo help <组>/);
  assert.doesNotMatch(result.stdout, /全部子命令/);
});

test("mo help --all 才是全部分组与子命令", () => {
  const result = run(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /一个新项目/);
  assert.match(result.stdout, /一个新任务/);
  assert.match(result.stdout, /mo task approve <id>/);
  assert.match(result.stdout, /全部子命令/);
  assert.match(result.stdout, /inbox\s+pull/);
  assert.match(result.stdout, /router/);
});

test("mo help <组> 给出该组子命令与说明", () => {
  const task = run(["help", "task"]);
  assert.equal(task.status, 0, task.stderr);
  assert.match(task.stdout, /mo task —— 任务卡/);
  assert.match(task.stdout, /mo task approve <id>/);
  assert.match(task.stdout, /全部命令：mo help/);

  const memory = run(["help", "memory"]);
  assert.match(memory.stdout, /mo memory create/);
});

test("组帮助带选项，而不是只列子命令", () => {
  const project = run(["help", "project"]);
  assert.match(project.stdout, /--mode auto\|skill\|ref\|inline/);
  assert.match(project.stdout, /--no-agent-file/);
  assert.match(project.stdout, /--remove/);

  const inbox = run(["help", "inbox"]);
  assert.match(inbox.stdout, /--wait 60s/);
  assert.match(inbox.stdout, /--peek/);

  const task = run(["help", "task"]);
  assert.match(task.stdout, /--verify run:\|check:\|human:/);
});

test("主帮助提到 inbox（等结果的入口）", () => {
  const result = run(["help"]);
  assert.match(result.stdout, /mo inbox pull/);
});

test("mo <组> --help 与 mo <组> help 等价", () => {
  const direct = run(["help", "task"]).stdout;
  assert.equal(run(["task", "--help"]).stdout, direct);
  assert.equal(run(["task", "help"]).stdout, direct);
});

test("未知分组：退出码 2 并列出可用分组", () => {
  const result = run(["help", "nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /没有这个组：nope/);
  assert.match(result.stderr, /task/);
});