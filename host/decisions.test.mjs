import test from "node:test";
import assert from "node:assert/strict";
import { approvalOutcomeFor, createDecisionRouter } from "./decisions.mjs";

const silent = { info: function () {}, warn: function () {} };

function dshMonitor(pendingItems) {
  const pending = new Map((pendingItems || []).map((item) => [item.eventId, item]));
  return {
    pending,
    resolved: [],
    resolvePending(id, reason) {
      this.resolved.push({ id, reason });
      pending.delete(id);
      return true;
    },
  };
}

test("approvalOutcomeFor 把 broker 决定翻成 DSH outcome", () => {
  assert.equal(approvalOutcomeFor("allow_once"), "allowed-once");
  assert.equal(approvalOutcomeFor("allow_always"), "allowed-once");
  assert.equal(approvalOutcomeFor("reject_once"), "rejected");
  assert.equal(approvalOutcomeFor("reject_always"), "rejected");
  assert.equal(approvalOutcomeFor("allowed-once"), "allowed-once");
  assert.equal(approvalOutcomeFor("rejected"), "rejected");
  assert.equal(approvalOutcomeFor("cancel"), "cancelled");
  assert.equal(approvalOutcomeFor("defer"), "");
});

test("broker 命中时不再碰 DSH", async () => {
  let dshCalls = 0;
  const router = createDecisionRouter({
    log: silent,
    broker: { decide: (id, decision) => id === "hook-1" },
    monitor: dshMonitor([{ eventId: "dsh-1", kind: "approval" }]),
    dsh: { answer: async () => { dshCalls += 1; } },
  });
  assert.equal(await router.decide("hook-1", "allow_once"), true);
  assert.equal(dshCalls, 0);
  assert.equal(await router.decide("nope", "allow_once"), false);
});

test("broker 没命中时，DSH 原生授权也能被手机放行", async () => {
  const answers = [];
  const monitor = dshMonitor([{ eventId: "dsh-1", kind: "approval" }]);
  const router = createDecisionRouter({
    log: silent,
    broker: { decide: () => false },
    monitor,
    dsh: { answer: async (id, outcome) => { answers.push({ id, outcome }); } },
  });
  assert.equal(await router.decide("dsh-1", "allow_once"), true);
  assert.deepEqual(answers, [{ id: "dsh-1", outcome: { kind: "result", value: "allowed-once" } }]);
  assert.deepEqual(monitor.resolved, [{ id: "dsh-1", reason: "answered" }]);
  assert.equal(monitor.pending.size, 0);
});

test("拒绝映射成 rejected；提问不在这里回答", async () => {
  const answers = [];
  const monitor = dshMonitor([
    { eventId: "dsh-approval", kind: "approval" },
    { eventId: "dsh-question", kind: "question" },
  ]);
  const router = createDecisionRouter({
    log: silent,
    broker: { decide: () => false },
    monitor,
    dsh: { answer: async (id, outcome) => { answers.push({ id, outcome }); } },
  });
  assert.equal(await router.decide("dsh-approval", "reject_once"), true);
  assert.equal(await router.decide("dsh-question", "allow_once"), false);
  assert.deepEqual(answers, [{ id: "dsh-approval", outcome: { kind: "result", value: "rejected" } }]);
});

test("DSH 回答失败时不清理待办，让用户还能重试", async () => {
  const monitor = dshMonitor([{ eventId: "dsh-1", kind: "approval" }]);
  const router = createDecisionRouter({
    log: silent,
    broker: { decide: () => false },
    monitor,
    dsh: { answer: async () => { throw new Error("events stream closed"); } },
  });
  assert.equal(await router.decide("dsh-1", "allow_once"), false);
  assert.equal(monitor.pending.size, 1);
  assert.deepEqual(monitor.resolved, []);
});
