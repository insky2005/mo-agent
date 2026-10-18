import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT,
  EVENT_META,
  NOTIFY_POLICY,
  SILENT_EVENTS,
  LEGACY_ALIASES,
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
    assert.ok(EVENT_META[type] || LEGACY_ALIASES[type], "策略引用了未知事件: " + type);
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

test("旧事件名都能归一化到规范事件", () => {
  for (const [legacy, canonical] of Object.entries(LEGACY_ALIASES)) {
    assert.equal(canonicalEventType(legacy), canonical);
    assert.ok(EVENT_META[canonical], "别名目标必须是规范事件: " + canonical);
  }
  assert.equal(canonicalEventType("agent.unknown"), null);
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

test("完成通知正文带 Agent 名，能区分 DSH / Claude", () => {
  const policy = NOTIFY_POLICY[EVENT.RUN_COMPLETED];
  const intent = policy({ agentLabel: "Claude Code", sessionTitle: "修 bug", text: "好了" });
  assert.match(intent.body, /Claude Code/);
  assert.match(intent.body, /修 bug/);
  assert.match(intent.body, /好了/);
});
