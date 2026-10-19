import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../core/hub.mjs";
import { ApprovalBroker, DECISION } from "./broker.mjs";

const silent = { info: function () {}, warn: function () {}, error: function () {} };

test("无决策端在线时交回本地，不挂起", async () => {
  const broker = new ApprovalBroker({
    hub: new Hub({ log: silent }),
    log: silent,
    isClientConnected: () => false,
  });
  const result = await broker.request({ agent: "claude", toolName: "Bash" });
  assert.equal(result.decision, DECISION.DEFER);
  assert.equal(result.reason, "no-client");
});

test("onPending 拿到 id 后 decide，请求正常 resolve", async () => {
  let seen = null;
  const broker = new ApprovalBroker({
    hub: new Hub({ log: silent }),
    log: silent,
    isClientConnected: () => true,
    timeoutMs: 1000,
    onPending: function (item) { seen = item; },
  });
  const pending = broker.request({
    agent: "claude",
    toolName: "Bash",
    toolInput: { command: "ls" },
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.ok(seen && seen.id);
  assert.equal(broker.list().length, 1);
  assert.equal(broker.decide(seen.id, DECISION.ALLOW_ONCE), true);
  const result = await pending;
  assert.equal(result.decision, DECISION.ALLOW_ONCE);
  assert.equal(broker.list().length, 0);
});

test("超时仍然 defer", async () => {
  let seen = null;
  const broker = new ApprovalBroker({
    hub: new Hub({ log: silent }),
    log: silent,
    isClientConnected: () => true,
    timeoutMs: 20,
    onPending: function (item) { seen = item; },
  });
  const pending = broker.request({ agent: "claude", toolName: "Bash" });
  await new Promise(function (resolve) { setImmediate(resolve); });
  const result = await pending;
  assert.equal(result.decision, DECISION.DEFER);
  assert.equal(result.reason, "timeout");
  assert.equal(broker.decide(seen.id, DECISION.ALLOW_ONCE), false);
});

test("提问类：questions 透传，answers 随决定返回给 hook", async () => {
  let seen = null;
  const broker = new ApprovalBroker({
    hub: new Hub({ log: silent }),
    log: silent,
    isClientConnected: () => true,
    timeoutMs: 1000,
    onPending: function (item) { seen = item; },
  });
  const questions = [{ question: "选哪个分支？", header: "分支", options: [{ label: "main" }, { label: "dev" }] }];
  const pending = broker.request({
    agent: "qoder-cn",
    agentLabel: "Qoder CN",
    toolName: "AskUserQuestion",
    toolInput: { questions },
    kind: "question",
    questions,
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.ok(seen && seen.id);

  const listed = broker.list()[0];
  assert.equal(listed.kind, "question");
  assert.deepEqual(listed.questions, questions);

  assert.equal(broker.decide(seen.id, DECISION.ALLOW_ONCE, { answers: { "选哪个分支？": "main" } }), true);
  const result = await pending;
  assert.equal(result.decision, DECISION.ALLOW_ONCE);
  assert.deepEqual(result.answers, { "选哪个分支？": "main" });
});
