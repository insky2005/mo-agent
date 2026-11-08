import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskWatch } from "./task-watch.mjs";
import { classifyEvent } from "../core/notify.mjs";
import { EVENT, missingFields } from "../core/contract.mjs";
import { attachProject } from "../cli/lib/project.mjs";
import { saveCard } from "../cli/lib/store.mjs";

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-task-watch-"));
  fs.mkdirSync(path.join(dir, "approvals"), { recursive: true });
  return dir;
}

function writeRequest(dir, id, patch = {}) {
  const item = {
    id,
    kind: "confirm",
    taskId: "t_1",
    project: "p_1",
    title: "加一个 daemon 命令",
    status: "pending",
    at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...patch,
  };
  fs.writeFileSync(path.join(dir, "approvals", id + ".json"), JSON.stringify(item));
  return item;
}

function fakeHub() {
  const events = [];
  return { events, emit: (type, payload) => events.push({ type, payload }) };
}

test("新的 pending 请求 → 一条 task.confirm_requested，且只发一次", () => {
  const dir = home();
  writeRequest(dir, "a_1");
  const hub = fakeHub();
  const watch = createTaskWatch({ home: dir, hub, log: { info() {}, warn() {} } });

  const first = watch.scan();
  assert.equal(first.length, 1);
  assert.equal(hub.events.length, 1);
  assert.equal(hub.events[0].type, EVENT.TASK_CONFIRM_REQUESTED);
  assert.equal(hub.events[0].payload.requestId, "a_1");
  assert.equal(hub.events[0].payload.taskId, "t_1");
  assert.equal(hub.events[0].payload.title, "加一个 daemon 命令");
  assert.equal(missingFields(EVENT.TASK_CONFIRM_REQUESTED, hub.events[0].payload).length, 0);

  const second = watch.scan();
  assert.deepEqual(second, []);
  assert.equal(hub.events.length, 1, "同一请求不应该重复提醒");
});

test("task.confirm_requested 能翻译成要人处理的 notify 意图", () => {
  const dir = home();
  writeRequest(dir, "a_2");
  const hub = fakeHub();
  const watch = createTaskWatch({ home: dir, hub });
  watch.scan();

  const intent = classifyEvent({ type: EVENT.TASK_CONFIRM_REQUESTED, payload: hub.events[0].payload });
  assert.ok(intent, "确认请求必须产生通知意图");
  assert.equal(intent.kind, "task-confirm");
  assert.equal(intent.severity, "critical");
  assert.equal(intent.requiresAction, true);
  assert.match(intent.body, /加一个 daemon 命令/);
  assert.equal(intent.eventId, "a_2", "同一个请求要能用 eventId 去重");
});

test("已决策的请求不提示", () => {
  const dir = home();
  writeRequest(dir, "a_3", { status: "approved" });
  const hub = fakeHub();
  const watch = createTaskWatch({ home: dir, hub });
  assert.deepEqual(watch.scan(), []);
  assert.equal(hub.events.length, 0);
});

test("过期请求不提示，也不会每轮重扫", () => {
  const dir = home();
  writeRequest(dir, "a_4", { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const hub = fakeHub();
  const watch = createTaskWatch({ home: dir, hub });
  assert.deepEqual(watch.scan(), []);
  assert.equal(hub.events.length, 0);
  assert.equal(watch.seen.has("a_4"), true);
});

test("approvals/ 不存在时不报错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-task-watch-empty-"));
  const watch = createTaskWatch({ home: dir, hub: fakeHub() });
  assert.deepEqual(watch.scan(), []);
});

test("start 立即扫一次，stop 之后不再扫", () => {
  const dir = home();
  writeRequest(dir, "a_5");
  const hub = fakeHub();
  const watch = createTaskWatch({ home: dir, hub, intervalMs: 20 });
  watch.start();
  assert.equal(hub.events.length, 1);
  watch.stop();
  writeRequest(dir, "a_6");
  const before = hub.events.length;
  const wait = Date.now() + 60;
  while (Date.now() < wait) {
    // 同步等待，确认没在跑
  }
  assert.equal(hub.events.length, before);
});

test("payload 带上卡的交付物与验收项（手机卡片要能显示批什么）", () => {
  const dir = home();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "mo-task-watch-proj-"));
  const attached = attachProject(project, { home: dir });
  saveCard(
    project,
    {
      id: "t_9",
      project: attached.meta.id,
      title: "加筛选",
      status: "draft",
      created: new Date().toISOString(),
      verify: [{ run: "npm test" }, { human: "看一眼" }],
    },
    "## 交付物\n\n- tasks.html 有筛选栏\n",
  );
  writeRequest(dir, "a_9", { taskId: "t_9", projectRoot: project, project: attached.meta.id });

  const hub = fakeHub();
  createTaskWatch({ home: dir, hub }).scan();
  const payload = hub.events[0].payload;
  assert.deepEqual(payload.deliverables, ["tasks.html 有筛选栏"]);
  assert.equal(payload.verify.length, 2);
  assert.equal(payload.verify[0], "run: npm test");
});
