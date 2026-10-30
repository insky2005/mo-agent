import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workerCommand } from "./commands/worker.mjs";
import { attachProject } from "./lib/project.mjs";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-worker-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.MO_AGENT_HOME = path.join(home, ".mo-agent");
  attachProject(project, { home: process.env.MO_AGENT_HOME });
  return { root, project, home };
}

function run(ws, args, options = {}) {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const code = workerCommand({ cwd: ws.project }, { positional: args, options });
    return { code, out: lines.join("") };
  } finally {
    process.stdout.write = original;
  }
}

const listJson = (ws, options = {}) => {
  const out = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  try {
    workerCommand({ cwd: ws.project }, { positional: ["list"], options: { ...options, json: [true] } });
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(out.join(""));
};

test("新增个人 worker 后出现在列表", () => {
  const ws = workspace();
  run(ws, ["add", "mine"], { command: ["claude -p hi"], description: ["我的"] });
  const { workers } = listJson(ws);
  const mine = workers.find((worker) => worker.name === "mine");
  assert.ok(mine);
  assert.equal(mine.source, "user");
  assert.equal(mine.command, "claude -p hi");
});

test("项目级覆盖个人级", () => {
  const ws = workspace();
  run(ws, ["add", "mine"], { command: ["user-cmd"] });
  run(ws, ["add", "mine", "--project"], { command: ["project-cmd"], project: [true] });
  const mine = listJson(ws).workers.find((worker) => worker.name === "mine");
  assert.equal(mine.source, "project");
  assert.equal(mine.command, "project-cmd");
});

test("remove 只删指定作用域", () => {
  const ws = workspace();
  run(ws, ["add", "mine"], { command: ["user-cmd"] });
  run(ws, ["add", "mine", "--project"], { command: ["project-cmd"], project: [true] });
  run(ws, ["remove", "mine"], {});
  const mine = listJson(ws).workers.find((worker) => worker.name === "mine");
  assert.equal(mine.source, "project"); // 个人那份删掉了，项目那份还在
});

test("内置模板不能删除，也不能重名", () => {
  const ws = workspace();
  assert.throws(() => run(ws, ["remove", "claude"]), (error) => error.code === "E_USAGE");
  assert.throws(() => run(ws, ["add", "claude"], { command: ["x"] }), (error) => error.code === "E_USAGE");
});

test("名称与命令校验", () => {
  const ws = workspace();
  assert.throws(() => run(ws, ["add", "Bad_Name"], { command: ["x"] }), (error) => error.code === "E_USAGE");
  assert.throws(() => run(ws, ["add", "ok-name"], { command: [""] }), (error) => error.code === "E_USAGE");
});

test("缺少名称时报 E_USAGE", () => {
  const ws = workspace();
  assert.throws(() => run(ws, ["add"], { command: ["x"] }), (error) => error.code === "E_USAGE");
});
