import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * 别名过渡（E1–E5）：新名字与旧名字必须完全等价，
 * 这样用户照着新文档敲、老脚本继续跑，两边都不炸。
 */

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-alias-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
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

function seeded(ws) {
  runJson(ws, ["project", "init", ".", "--no-agent-file"]);
  const created = runJson(ws, ["task", "create", "--title", "别名", "--deliverable", "x", "--exec", "node -e 0"]);
  return created.parsed.taskId;
}

test("task show 与 task status 完全等价", () => {
  const ws = workspace();
  const taskId = seeded(ws);
  const shown = runJson(ws, ["task", "show", taskId]);
  const status = runJson(ws, ["task", "status", taskId]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(shown.parsed, status.parsed);
});

test("project create 与 project init 等价", () => {
  const ws = workspace();
  const created = runJson(ws, ["project", "create", ".", "--no-agent-file"]);
  assert.equal(created.status, 0, created.stderr);
  const listed = runJson(ws, ["project", "list"]);
  assert.equal(listed.parsed.projects.length, 1);
});

test("connect describe 与 agent describe 等价", () => {
  const ws = workspace();
  const a = runJson(ws, ["agent", "describe"]);
  const b = runJson(ws, ["connect", "describe"]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.stdout, a.stdout);
});

test("internal receipt 与顶层 receipt 等价（错误码一致）", () => {
  const ws = workspace();
  const top = run(ws, ["receipt"]);
  const inner = run(ws, ["internal", "receipt"]);
  assert.notEqual(top.status, 0);
  assert.equal(inner.status, top.status);
  assert.match(inner.stderr, /E_USAGE/);
});

test("serve status 与 daemon status 等价", () => {
  const ws = workspace();
  const daemon = run(ws, ["daemon", "status"]);
  const serve = run(ws, ["serve", "status"]);
  assert.equal(serve.exitCode ?? serve.status, daemon.exitCode ?? daemon.status);
  assert.equal(serve.stdout, daemon.stdout);
});

test("旧顶层名给 deprecation 提示，但仍能跑", () => {
  const ws = workspace();
  const result = run(ws, ["completion", "zsh"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[deprecated\] mo completion → mo internal completion/);
  assert.match(result.stdout, /compdef _mo mo/);
});

test("mo help daemon 解析到 serve 分组", () => {
  const ws = workspace();
  assert.equal(run(ws, ["help", "daemon"]).stdout, run(ws, ["help", "serve"]).stdout);
});

test("worker use 不带名字 = 打印当前默认（current 是冗余别名）", () => {
  const ws = workspace();
  const bare = runJson(ws, ["worker", "use"]);
  const explicit = runJson(ws, ["worker", "current"]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(bare.parsed, explicit.parsed);
});

test("internal 未知子命令 → E_USAGE 并列出可用", () => {
  const ws = workspace();
  const result = run(ws, ["internal", "nope"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E_USAGE/);
  assert.match(result.stderr, /receipt \/ watchdog \/ mcp \/ completion/);
});

// ---- 第二批别名：memory create / worker current / connect project（E1–E6 收口）----

test("memory create 与 memory init 等价；init 带迁移提示与移除版本", () => {
  const a = workspace();
  const b = workspace();
  const created = runJson(a, ["memory", "create"]);
  const initialized = runJson(b, ["memory", "init"]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(created.parsed.ok, true);
  assert.deepEqual(created.parsed.created, initialized.parsed.created);
  assert.match(initialized.stderr, /\[deprecated\] mo memory init → mo memory create/);
  assert.match(initialized.stderr, /0\.5\.0/);
});

test("worker current 与 worker use 等价，且提示迁移", () => {
  const ws = workspace();
  const current = runJson(ws, ["worker", "current"]);
  const use = runJson(ws, ["worker", "use"]);
  assert.deepEqual(current.parsed, use.parsed);
  assert.match(current.stderr, /mo worker current → mo worker use/);
});

test("terminal current 与 terminal use 等价，且提示迁移", () => {
  const ws = workspace();
  const current = runJson(ws, ["terminal", "current"]);
  const use = runJson(ws, ["terminal", "use"]);
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual(current.parsed, use.parsed);
  assert.match(current.stderr, /mo terminal current → mo terminal use/);
});

test("connect project 能写 Agent 说明段；project agent 仍可用并提示迁移", () => {
  const ws = workspace();
  runJson(ws, ["project", "init", ".", "--no-agent-file"]);
  const viaConnect = run(ws, ["connect", "project"]);
  assert.equal(viaConnect.status, 0, viaConnect.stderr);
  const agentsFile = path.join(ws.project, "AGENTS.md");
  assert.equal(fs.existsSync(agentsFile), true);

  const viaProject = run(ws, ["project", "agent"]);
  assert.equal(viaProject.status, 0, viaProject.stderr);
  assert.match(viaProject.stderr, /mo project agent → mo connect project/);
});

test("internal memory-migrate 可用（没东西可迁也不报错）", () => {
  const ws = workspace();
  const result = runJson(ws, ["internal", "memory-migrate", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
});
