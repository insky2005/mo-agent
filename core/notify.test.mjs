import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "./hub.mjs";
import { Notifier, SEVERITY, classifyEvent, notificationKey } from "./notify.mjs";
import { EVENT } from "./events.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function eventOf(type, payload, seq) {
  return { seq: seq || 1, at: Date.now(), type, payload };
}

function makeHub() {
  const hub = new Hub({ log: quiet });
  const notifies = [];
  hub.store.subscribe((e) => {
    if (e.type === EVENT.NOTIFY) notifies.push(e.payload);
  });
  const notifier = new Notifier({ hub, log: quiet });
  notifier.start();
  return { hub, notifier, notifies };
}

test("approval.pending -> critical，带 eventId", () => {
  const intent = classifyEvent(eventOf(EVENT.APPROVAL_PENDING, { id: "a1", agentLabel: "Claude Code", toolName: "Bash", title: "运行 rm" }));
  assert.equal(intent.severity, SEVERITY.CRITICAL);
  assert.equal(intent.kind, "approval");
  assert.equal(intent.eventId, "a1");
  assert.equal(intent.title, "授权请求");
  assert.match(intent.body, /Claude Code/);
  assert.match(intent.body, /运行 rm/);
});

test("pending.added 的提问 -> critical，body 取问题文本", () => {
  const intent = classifyEvent(eventOf("pending.added", { eventId: "q1", kind: "question", question: { questions: [{ question: "选哪个分支？" }] } }));
  assert.equal(intent.severity, SEVERITY.CRITICAL);
  assert.equal(intent.kind, "question");
  assert.equal(intent.body, "选哪个分支？");
});

test("notice completed -> normal「任务完成」，error -> critical「出错了」", () => {
  const done = classifyEvent(eventOf(EVENT.NOTICE, { kind: "completed", title: "任务完成" }));
  assert.equal(done.severity, SEVERITY.NORMAL);
  assert.equal(done.title, "任务完成");
  const bad = classifyEvent(eventOf(EVENT.NOTICE, { kind: "error", title: "Agent 出错" }));
  assert.equal(bad.severity, SEVERITY.CRITICAL);
  assert.equal(bad.title, "出错了");
});

test("pending.added 带会话标题：正文是「会话 · 问题」", () => {
  const intent = classifyEvent(eventOf("pending.added", {
    eventId: "q2",
    kind: "question",
    sessionTitle: "mo-agent",
    question: { questions: [{ question: "选哪个分支？" }] },
  }));
  assert.equal(intent.title, "等待回答");
  assert.equal(intent.body, "mo-agent · 选哪个分支？");
});

test("无关事件不产生通知", () => {
  assert.equal(classifyEvent(eventOf("session.upsert", { sessionId: "s1" })), null);
  const { hub, notifies } = makeHub();
  hub.emit("session.upsert", { sessionId: "s1" });
  assert.equal(notifies.length, 0);
});

test("Notifier 把 approval.pending 变成一条 notify 事件", () => {
  const { hub, notifies } = makeHub();
  hub.emit(EVENT.APPROVAL_PENDING, { id: "a1", agentLabel: "Claude Code", title: "需要授权" });
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].kind, "approval");
  assert.equal(notifies[0].eventId, "a1");
  assert.ok(notifies[0].sourceSeq > 0);
});

test("同一件授权重复来只通知一次（去重）", () => {
  const { hub, notifies } = makeHub();
  hub.emit(EVENT.APPROVAL_PENDING, { id: "a1", title: "需要授权" });
  hub.emit(EVENT.APPROVAL_PENDING, { id: "a1", title: "需要授权" });
  assert.equal(notifies.length, 1);
  hub.emit(EVENT.APPROVAL_PENDING, { id: "a2", title: "需要授权" });
  assert.equal(notifies.length, 2);
});

test("channel 会收到翻译后的意图", () => {
  const hub = new Hub({ log: quiet });
  const got = [];
  const notifier = new Notifier({ hub, log: quiet });
  notifier.register({ send: (payload) => got.push(payload) });
  notifier.start();
  hub.emit(EVENT.NOTICE, { kind: "error", title: "Agent 出错", body: "boom" });
  assert.equal(got.length, 1);
  assert.equal(got[0].severity, SEVERITY.CRITICAL);
});

test("去重键：有 eventId 用 id，否则用 seq", () => {
  assert.equal(notificationKey({ type: "pending.added", seq: 3 }, { eventId: "x" }), "pending.added:x");
  assert.equal(notificationKey({ type: "notice", seq: 3 }, { eventId: null }), "notice:3");
});
test("agent.run.completed -> normal「任务完成」，带会话与回答", () => {
  const intent = classifyEvent(eventOf(EVENT.RUN_COMPLETED, {
    id: "claude-code:s1",
    sessionId: "claude-code:s1",
    agent: "claude-code",
    title: "authx-mcp read",
    sessionTitle: "authx-mcp read",
    text: "只装了一个：authx-mcp",
  }));
  assert.equal(intent.severity, SEVERITY.NORMAL);
  assert.equal(intent.kind, "completed");
  assert.equal(intent.title, "任务完成");
  assert.equal(intent.sessionId, "claude-code:s1");
  assert.match(intent.body, /authx-mcp read/);
  assert.match(intent.body, /只装了一个/);
});
test("同一 runId 的完成事件只通知一次", () => {
  const { hub, notifies } = makeHub();
  hub.emit(EVENT.RUN_COMPLETED, { runId: "s1:turn:1", sessionId: "s1", agent: "dsh", title: "t", text: "done" });
  hub.emit(EVENT.RUN_COMPLETED, { runId: "s1:turn:1", sessionId: "s1", agent: "dsh", title: "t", text: "done" });
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].runId, "s1:turn:1");
});
