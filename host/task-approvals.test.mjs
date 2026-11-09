import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachProject } from "../cli/lib/project.mjs";
import { loadCard, readEvents, saveCard } from "../cli/lib/store.mjs";
import { requestConfirmation } from "../cli/lib/approvals.mjs";
import { decideTaskApproval, dispatchApprovedTask, listTaskApprovals } from "./task-approvals.mjs";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-taskappr-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.MO_AGENT_HOME = home;
  const attached = attachProject(project, { home });
  return { root, project, home, projectId: attached.meta.id };
}

function makeCard(ws, id = "t_1", title = "加筛选") {
  saveCard(
    ws.project,
    { id, project: ws.projectId, title, status: "draft", created: "2026-01-01T00:00:00.000Z", verify: [{ run: "true" }] },
    "## 交付物\n\n- tasks.html 有筛选栏\n",
  );
  return loadCard(ws.project, id);
}

function pendingRequest(ws, card) {
  return requestConfirmation({ home: ws.home, root: ws.project, card }).request;
}

test("列待批任务确认请求", () => {
  const ws = workspace();
  const card = makeCard(ws);
  const request = pendingRequest(ws, card);

  const pending = listTaskApprovals({ home: ws.home });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, request.id);
  assert.equal(pending[0].taskId, "t_1");
  assert.equal(pending[0].title, "加筛选");
  assert.match(pending[0].cardHash, /^[a-f0-9]{64}$/);
});

test("approve：卡变 confirmed，账本记 human + channel web", () => {
  const ws = workspace();
  const card = makeCard(ws);
  const request = pendingRequest(ws, card);

  const result = decideTaskApproval({ home: ws.home, id: request.id, decision: "approve" });
  assert.equal(result.status, "approved");
  assert.equal(loadCard(ws.project, "t_1").meta.status, "confirmed");

  const events = readEvents(ws.home).filter((event) => event.taskId === "t_1");
  const confirmed = events.find((event) => event.type === "task.confirmed");
  assert.equal(confirmed.actor, "human");
  assert.equal(confirmed.payload.channel, "web");
  assert.equal(confirmed.payload.requestId, request.id);

  assert.deepEqual(listTaskApprovals({ home: ws.home }), []);
});

test("reject：卡留在 draft", () => {
  const ws = workspace();
  const card = makeCard(ws);
  const request = pendingRequest(ws, card);

  const result = decideTaskApproval({ home: ws.home, id: request.id, decision: "reject" });
  assert.equal(result.status, "rejected");
  assert.equal(loadCard(ws.project, "t_1").meta.status, "draft");
});

test("批准前卡片被改 → E_CARD_CHANGED", () => {
  const ws = workspace();
  const card = makeCard(ws);
  const request = pendingRequest(ws, card);

  const file = path.join(ws.project, ".mo-agent", "tasks", "t_1.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\n偷偷改一条\n");

  assert.throws(
    () => decideTaskApproval({ home: ws.home, id: request.id, decision: "approve" }),
    (error) => error.code === "E_CARD_CHANGED",
  );
  assert.equal(loadCard(ws.project, "t_1").meta.status, "draft");
});

test("未知请求 / 已结束请求都报 E_NOT_FOUND", () => {
  const ws = workspace();
  const card = makeCard(ws);
  const request = pendingRequest(ws, card);

  assert.throws(
    () => decideTaskApproval({ home: ws.home, id: "a_NOPE", decision: "approve" }),
    (error) => error.code === "E_NOT_FOUND",
  );

  decideTaskApproval({ home: ws.home, id: request.id, decision: "approve" });
  assert.throws(
    () => decideTaskApproval({ home: ws.home, id: request.id, decision: "approve" }),
    (error) => error.code === "E_NOT_FOUND",
  );
});

test("非法 decision 被拒", () => {
  const ws = workspace();
  const card = makeCard(ws);
  const request = pendingRequest(ws, card);
  assert.throws(
    () => decideTaskApproval({ home: ws.home, id: request.id, decision: "allow" }),
    (error) => error.code === "E_USAGE",
  );
});

// ---- 批准并派单（B3）----

function cardWithExec(ws, exec) {
  saveCard(
    ws.project,
    { id: "t_2", project: ws.projectId, title: "带执行者", status: "draft", created: "2026-01-01T00:00:00.000Z", exec, verify: [{ run: "true" }] },
    "## 交付物\n\n- x\n",
  );
  return loadCard(ws.project, "t_2");
}

test("批准并派单：用卡上的 exec 起跑，HTTP 立刻返回", () => {
  const ws = workspace();
  const card = cardWithExec(ws, "node -e 0");
  const request = pendingRequest(ws, card);
  decideTaskApproval({ home: ws.home, id: request.id, decision: "approve" });

  const calls = [];
  const result = dispatchApprovedTask({
    home: ws.home,
    id: request.id,
    runner: (args) => {
      calls.push(args);
      return Promise.resolve({ status: "blocked" });
    },
  });

  assert.equal(result.taskId, "t_2");
  assert.equal(result.exec, "node -e 0");
  assert.equal(result.started, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exec, "node -e 0");
  assert.equal(calls[0].taskId, "t_2");
  assert.equal(calls[0].actor, "agent");
});

test("批准并派单：请求还没批准时拒绝", () => {
  const ws = workspace();
  const card = cardWithExec(ws, "node -e 0");
  const request = pendingRequest(ws, card);
  assert.throws(
    () => dispatchApprovedTask({ home: ws.home, id: request.id }),
    (error) => error.code === "E_NOT_CONFIRMED",
  );
});

test("批准并派单：卡上没执行者也没有默认执行者 → E_NO_EXECUTOR", () => {
  const ws = workspace();
  const card = cardWithExec(ws, undefined);
  const request = pendingRequest(ws, card);
  decideTaskApproval({ home: ws.home, id: request.id, decision: "approve" });
  assert.throws(
    () => dispatchApprovedTask({ home: ws.home, id: request.id }),
    (error) => error.code === "E_NO_EXECUTOR",
  );
});
