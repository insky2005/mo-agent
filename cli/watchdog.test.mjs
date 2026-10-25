import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { attachProject } from "./lib/project.mjs";
import { loadCard, readEvents, saveCard } from "./lib/store.mjs";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mo-watchdog-")));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.MO_AGENT_HOME = home;
  const attached = attachProject(project, { home });
  return { root, project, home, projectId: attached.meta.id };
}

function run(ws, args, cwd = ws.project) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd,
    env: { ...process.env, MO_AGENT_HOME: ws.home },
    encoding: "utf8",
  });
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

function staleCard(ws, id = "t_stale", over = {}) {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  saveCard(
    ws.project,
    {
      id,
      project: ws.projectId,
      title: "跑了两小时还没回执",
      status: "running",
      created: twoHoursAgo,
      updated: twoHoursAgo,
      timeout: "45m",
      ...over,
    },
    "## 交付物\n\n- x\n",
  );
}

test("超时的 running 卡转 blocked(timeout)，并进收件箱", () => {
  const ws = workspace();
  staleCard(ws);

  const result = runJson(ws, ["watchdog", "run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.parsed.checked, 1);
  assert.equal(result.parsed.overdue.length, 1);

  assert.equal(loadCard(ws.project, "t_stale").meta.status, "blocked");

  const events = readEvents(ws.home).filter((event) => event.taskId === "t_stale");
  const blocked = events.find((event) => event.type === "task.blocked");
  assert.equal(blocked.payload.reason, "timeout");

  const inbox = runJson(ws, ["inbox", "pull", "--peek"]);
  assert.equal(inbox.parsed.count, 1);
  assert.equal(inbox.parsed.items[0].reason, "timeout");
  assert.match(inbox.parsed.items[0].summary, /没有回执/);
});

test("--dry-run 只报告，不改状态", () => {
  const ws = workspace();
  staleCard(ws);

  const result = runJson(ws, ["watchdog", "run", "--dry-run"]);
  assert.equal(result.parsed.overdue.length, 1);
  assert.equal(loadCard(ws.project, "t_stale").meta.status, "running");
});

test("没超时的卡不动", () => {
  const ws = workspace();
  staleCard(ws, "t_fresh", { updated: new Date().toISOString() });
  assert.equal(runJson(ws, ["watchdog", "run"]).parsed.overdue.length, 0);
  assert.equal(loadCard(ws.project, "t_fresh").meta.status, "running");
});

test("--all 扫全部已登记项目", () => {
  const ws = workspace();
  const second = path.join(ws.root, "proj2");
  fs.mkdirSync(second, { recursive: true });
  const attached = attachProject(second, { home: ws.home });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  saveCard(
    second,
    { id: "t_other", project: attached.meta.id, title: "另一个项目", status: "running", created: twoHoursAgo, updated: twoHoursAgo, timeout: "45m" },
    "## 交付物\n\n- x\n",
  );

  const result = runJson(ws, ["watchdog", "run", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.parsed.overdue.length, 1);
  assert.equal(result.parsed.overdue[0].taskId, "t_other");
  assert.equal(loadCard(second, "t_other").meta.status, "blocked");
});

test("inbox pull --wait 会先扫一遍超时，把超时通知带回来", () => {
  const ws = workspace();
  staleCard(ws);

  const pulled = runJson(ws, ["inbox", "pull", "--wait", "2s"]);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(pulled.parsed.count, 1);
  assert.equal(pulled.parsed.items[0].reason, "timeout");
});

test("不在项目里报 E_PROJECT_UNBOUND", () => {
  const ws = workspace();
  const outside = path.join(ws.root, "loose");
  fs.mkdirSync(outside, { recursive: true });
  const result = run(ws, ["watchdog", "run"], outside);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_PROJECT_UNBOUND/);
});
