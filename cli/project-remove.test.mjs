import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mo-projrm-")));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}

function run(ws, args, cwd) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: cwd || ws.root,
    env: { ...process.env, MO_AGENT_HOME: ws.home },
    encoding: "utf8",
  });
}

function runJson(ws, args, cwd) {
  const result = run(ws, [...args, "--json"], cwd);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

function project(ws, name) {
  const dir = path.join(ws.root, name);
  fs.mkdirSync(dir, { recursive: true });
  const added = runJson(ws, ["project", "init", ".", "--no-agent-file"], dir);
  assert.equal(added.status, 0, added.stderr);
  return { dir, id: added.parsed.id };
}

test("按名称移除：只动注册表，仓库文件保留", () => {
  const ws = workspace();
  const alpha = project(ws, "alpha");
  project(ws, "beta");

  const removed = runJson(ws, ["project", "remove", "alpha"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.parsed.id, alpha.id);
  assert.deepEqual(removed.parsed.remainingPaths, []);

  const listed = runJson(ws, ["project", "list"]);
  assert.equal(listed.parsed.projects.length, 1);
  assert.equal(listed.parsed.projects[0].name, "beta");

  // 仓库里的 project.json 还在
  assert.equal(fs.existsSync(path.join(alpha.dir, ".mo-agent", "project.json")), true);
});

test("按路径移除：只摘掉那个位置，项目还在", () => {
  const ws = workspace();
  const alpha = project(ws, "alpha");
  const clone = path.join(ws.root, "alpha-clone");
  fs.cpSync(alpha.dir, clone, { recursive: true });
  const added = runJson(ws, ["project", "init", ".", "--no-agent-file"], clone);
  assert.equal(added.status, 0, added.stderr);

  const removed = runJson(ws, ["project", "remove", alpha.id, "--path", clone]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(removed.parsed.removedPaths, [clone]);
  assert.deepEqual(removed.parsed.remainingPaths, [alpha.dir]);

  const listed = runJson(ws, ["project", "list"]);
  assert.equal(listed.parsed.projects.length, 1);
  assert.deepEqual(listed.parsed.projects[0].paths, [alpha.dir]);
});

test("--dry-run 不改注册表", () => {
  const ws = workspace();
  project(ws, "alpha");

  const dry = runJson(ws, ["project", "remove", "alpha", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.parsed.dryRun, true);
  assert.equal(runJson(ws, ["project", "list"]).parsed.projects.length, 1);
});

test("找不到项目时报 E_PROJECT_NOT_FOUND", () => {
  const ws = workspace();
  project(ws, "alpha");

  const result = run(ws, ["project", "remove", "nope"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_PROJECT_NOT_FOUND/);
});

test("--path 没登记过时报错并列出登记位置", () => {
  const ws = workspace();
  project(ws, "alpha");

  const result = run(ws, ["project", "remove", "alpha", "--path", path.join(ws.root, "elsewhere")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_PROJECT_NOT_FOUND/);
  assert.match(result.stderr, /登记的位置/);
});

test("--purge 在非 TTY 下必须显式 --yes", () => {
  const ws = workspace();
  const alpha = project(ws, "alpha");

  const denied = run(ws, ["project", "remove", "alpha", "--purge"]);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /E_FORBIDDEN/);
  assert.equal(fs.existsSync(path.join(alpha.dir, ".mo-agent")), true, "被拒绝时不该删文件");

  const purged = runJson(ws, ["project", "remove", "alpha", "--purge", "--yes"]);
  assert.equal(purged.status, 0, purged.stderr);
  assert.deepEqual(purged.parsed.purged, [alpha.dir]);
  assert.equal(fs.existsSync(path.join(alpha.dir, ".mo-agent")), false);
});

test("多个登记位置时 --purge 必须用 --path 指定", () => {
  const ws = workspace();
  const alpha = project(ws, "alpha");
  const clone = path.join(ws.root, "clone");
  fs.cpSync(alpha.dir, clone, { recursive: true });
  runJson(ws, ["project", "init", ".", "--no-agent-file"], clone);

  const result = run(ws, ["project", "remove", "alpha", "--purge", "--yes"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_USAGE/);
  assert.equal(fs.existsSync(path.join(clone, ".mo-agent")), true);
});
