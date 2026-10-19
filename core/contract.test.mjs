import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT,
  EVENT_META,
  NOTIFY_POLICY,
  SILENT_EVENTS,
  canonicalEventType,
  missingFields,
  SEVERITY,
  makeRunId,
  canControl,
} from "./contract.mjs";

test("每个规范事件都有通知策略，或显式标记为静默", () => {
  for (const type of Object.keys(EVENT_META)) {
    if (type === EVENT.NOTIFY) continue; // 派生输出，不再产生通知
    const covered = typeof NOTIFY_POLICY[type] === "function" || SILENT_EVENTS.has(type);
    assert.ok(covered, "缺少通知策略或静默声明: " + type);
  }
});

test("通知策略只引用已知事件", () => {
  for (const type of Object.keys(NOTIFY_POLICY)) {
    assert.ok(EVENT_META[type], "策略引用了未知事件: " + type);
  }
});

test("通知策略返回完整意图", () => {
  for (const [type, policy] of Object.entries(NOTIFY_POLICY)) {
    const intent = policy({});
    assert.equal(typeof intent, "object", type);
    assert.ok(Object.values(SEVERITY).includes(intent.severity), type + " severity");
    assert.equal(typeof intent.kind, "string", type + " kind");
    assert.equal(typeof intent.title, "string", type + " title");
    assert.equal(typeof intent.body, "string", type + " body");
  }
});

test("M4 起旧 agent.* / needs.* 事件名不再被接受", () => {
  for (const legacy of ["agent.added", "agent.updated", "agent.removed", "agent.run.completed", "agent.needs.auth", "agent.needs.input", "session.started", "dsh.error"]) {
    assert.equal(canonicalEventType(legacy), null, legacy);
  }
  assert.equal(canonicalEventType(EVENT.SESSION_UPSERT), EVENT.SESSION_UPSERT);
});

test("必填字段检查能发现缺失", () => {
  assert.deepEqual(missingFields(EVENT.SESSION_UPSERT, {}), ["sessionId", "agent", "status", "running", "updatedAt"]);
  assert.deepEqual(missingFields(EVENT.SESSION_UPSERT, {
    sessionId: "s1",
    agent: "dsh",
    status: "working",
    running: false,
    updatedAt: 1,
  }), []);
  assert.deepEqual(missingFields(EVENT.RUN_COMPLETED, { sessionId: "s1" }), ["runId"]);
});

test("runId 稳定且按会话隔离", () => {
  assert.equal(makeRunId("s1", 1), "s1:turn:1");
  assert.equal(makeRunId("s2", 1), "s2:turn:1");
});
test("canControl 按 capabilities 判断，Claude 默认只读", () => {
  assert.equal(canControl({ agent: "dsh", capabilities: { control: ["prompt", "cancel"] } }, "prompt"), true);
  assert.equal(canControl({ agent: "claude-code", capabilities: { control: [] } }, "prompt"), false);
  assert.equal(canControl({ agent: "claude-code" }, "prompt"), false, "旧快照也不能给 Claude 发送");
  assert.equal(canControl({ agent: "dsh" }, "prompt"), true, "旧 DSH 快照保持可发送");
  assert.equal(canControl(null, "prompt"), false);
});

test("完成通知把 Agent 名放标题后缀，正文只留会话与回答", () => {
  const policy = NOTIFY_POLICY[EVENT.RUN_COMPLETED];
  const intent = policy({ agentLabel: "Claude Code", sessionTitle: "修 bug", text: "好了" });
  assert.equal(intent.title, "任务完成 [Claude Code]");
  assert.equal(intent.body, "修 bug · 好了");
  assert.doesNotMatch(intent.body, /Claude Code/);
});

test("没有 agentLabel 时标题保持旧格式", () => {
  const policy = NOTIFY_POLICY[EVENT.RUN_COMPLETED];
  const intent = policy({ sessionTitle: "修 bug", text: "好了" });
  assert.equal(intent.title, "任务完成");
});

test("标题已经带相同 Agent 后缀时不重复追加", () => {
  const policy = NOTIFY_POLICY[EVENT.NOTICE];
  const intent = policy({ title: "提醒 [Claude Code]", agentLabel: "Claude Code" });
  assert.equal(intent.title, "提醒 [Claude Code]");
});
