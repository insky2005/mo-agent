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
  assert.equal(intent.title, "授权请求 [Claude Code]");
  assert.equal(intent.body, "运行 rm");
});

test("pending.added 的提问 -> critical，body 取问题文本", () => {
  const intent = classifyEvent(eventOf("pending.added", { eventId: "q1", kind: "question", question: { questions: [{ question: "选哪个分支？" }] } }));
  assert.equal(intent.severity, SEVERITY.CRITICAL);
  assert.equal(intent.kind, "question");
  assert.equal(intent.body, "选哪个分支？");
});

test("notice 默认 critical，但允许通知类型覆盖级别", () => {
  const attention = classifyEvent(eventOf(EVENT.NOTICE, { kind: "attention", title: "需要你的关注" }));
  assert.equal(attention.severity, SEVERITY.CRITICAL);
  assert.equal(attention.title, "需要你的关注");
  const legacy = classifyEvent(eventOf(EVENT.NOTICE, { kind: "completed", title: "任务完成" }));
  assert.equal(legacy.severity, SEVERITY.CRITICAL, "没声明 severity 时保持 critical");
  const completed = classifyEvent(eventOf(EVENT.NOTICE, { kind: "completed", title: "任务完成", severity: SEVERITY.NORMAL, agentLabel: "Claude Code" }));
  assert.equal(completed.severity, SEVERITY.NORMAL);
  assert.equal(completed.title, "任务完成 [Claude Code]");
});

test("notice 的 Agent 名进标题，正文用会话标题", () => {
  const intent = classifyEvent(eventOf(EVENT.NOTICE, {
    kind: "question",
    title: "等待回答",
    body: "Claude is waiting for your input",
    agentLabel: "Claude Code",
    sessionTitle: "authx-mcp read",
    notificationType: "idle_prompt",
  }));
  assert.equal(intent.title, "等待回答 [Claude Code]");
  assert.equal(intent.body, "authx-mcp read · Claude is waiting for your input");
  assert.equal(intent.notificationType, "idle_prompt");
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

test("requiresAction：授权/提问/失败为 true，完成为 false", () => {
  assert.equal(classifyEvent(eventOf(EVENT.APPROVAL_PENDING, { id: "a1" })).requiresAction, true);
  assert.equal(classifyEvent(eventOf(EVENT.PENDING_ADDED, { eventId: "q1", kind: "question" })).requiresAction, true);
  assert.equal(classifyEvent(eventOf(EVENT.RUN_FAILED, { runId: "r1", text: "x" })).requiresAction, true);
  assert.equal(classifyEvent(eventOf(EVENT.RUN_COMPLETED, { runId: "r2", text: "x" })).requiresAction, false);
});

test("channel.accepts 为 false 时不发送", () => {
  const hub = new Hub({ log: quiet });
  const got = [];
  const notifier = new Notifier({ hub, log: quiet });
  notifier.register({ accepts: () => false, send: (payload) => got.push(payload) });
  notifier.register({ send: (payload) => got.push(payload) });
  notifier.start();
  hub.emit(EVENT.APPROVAL_PENDING, { id: "a1", title: "需要授权" });
  assert.equal(got.length, 1);
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


// ---- 静音时段与去重淘汰（D3）----

test("静音时段：NORMAL 通知被跳过，CRITICAL 照常放行", () => {
  const hub = new Hub({ log: quiet });
  const got = [];
  const notifier = new Notifier({
    hub,
    log: quiet,
    quietHours: { start: "22:00", end: "08:00" },
    now: () => new Date(2026, 0, 1, 23, 30),
  });
  notifier.register({ send: (payload) => got.push(payload) });
  notifier.start();

  hub.emit(EVENT.RUN_COMPLETED, { runId: "r1", sessionId: "s1", agent: "dsh", title: "t", text: "done" });
  assert.equal(got.length, 0, "夜里不该为“任务完成”吵人");

  hub.emit(EVENT.APPROVAL_PENDING, { id: "a1", title: "需要授权" });
  assert.equal(got.length, 1, "授权是 critical，静音时段也要放行");
  assert.equal(got[0].severity, SEVERITY.CRITICAL);
});

test("静音时段：白天不生效；跨零点窗口两头都算", () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  const window = { start: "22:00", end: "08:00" };

  const run = (hour) => {
    const hub = new Hub({ log: quiet });
    const got = [];
    const notifier = new Notifier({ hub, log: quiet, quietHours: window, now: () => at(hour, 0) });
    notifier.register({ send: (payload) => got.push(payload) });
    notifier.start();
    hub.emit(EVENT.RUN_COMPLETED, { runId: "r" + hour, sessionId: "s", agent: "dsh", title: "t", text: "done" });
    return got.length;
  };

  assert.equal(run(12), 1, "中午应该正常通知");
  assert.equal(run(23), 0, "23 点在窗口内");
  assert.equal(run(3), 0, "凌晨 3 点在跨零点窗口内");
  assert.equal(run(9), 1, "9 点已经出了窗口");
});

test("静音时段：allowCritical=false 时连 critical 也挡", () => {
  const hub = new Hub({ log: quiet });
  const got = [];
  const notifier = new Notifier({
    hub,
    log: quiet,
    quietHours: { start: "00:00", end: "23:59", allowCritical: false },
    now: () => new Date(2026, 0, 1, 12, 0),
  });
  notifier.register({ send: (payload) => got.push(payload) });
  notifier.start();
  hub.emit(EVENT.APPROVAL_PENDING, { id: "a1", title: "需要授权" });
  assert.equal(got.length, 0);
});

test("静音配置非法/关闭时不生效", () => {
  const hub = new Hub({ log: quiet });
  const got = [];
  const notifier = new Notifier({
    hub,
    log: quiet,
    quietHours: { start: "25:99", end: "08:00", enabled: false },
    now: () => new Date(2026, 0, 1, 3, 0),
  });
  notifier.register({ send: (payload) => got.push(payload) });
  notifier.start();
  hub.emit(EVENT.RUN_COMPLETED, { runId: "r1", sessionId: "s", agent: "dsh", title: "t", text: "done" });
  assert.equal(got.length, 1);
});

test("去重表满了只淘汰最旧的，不会整表清空后重复提醒", () => {
  const hub = new Hub({ log: quiet });
  const got = [];
  const notifier = new Notifier({ hub, log: quiet, maxSeen: 2 });
  notifier.register({ send: (payload) => got.push(payload) });
  notifier.start();

  hub.emit(EVENT.RUN_COMPLETED, { runId: "r1", sessionId: "s1", agent: "dsh", title: "t1", text: "x" });
  hub.emit(EVENT.RUN_COMPLETED, { runId: "r2", sessionId: "s2", agent: "dsh", title: "t2", text: "x" });
  assert.equal(got.length, 2);

  // 第三条挤掉 r1；此时再发 r2 仍然应该被去重
  hub.emit(EVENT.RUN_COMPLETED, { runId: "r3", sessionId: "s3", agent: "dsh", title: "t3", text: "x" });
  assert.equal(got.length, 3);
  hub.emit(EVENT.RUN_COMPLETED, { runId: "r2", sessionId: "s2", agent: "dsh", title: "t2", text: "x" });
  assert.equal(got.length, 3, "r2 还在去重表里，不该重复通知");
  assert.equal(notifier.seen.has("run:r2"), true);
  assert.equal(notifier.seen.has("run:r1"), false, "最旧的被淘汰");
});
