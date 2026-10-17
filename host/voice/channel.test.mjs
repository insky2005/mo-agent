import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkVoiceReady, createVoiceChannel, decisionForOutcome, parseMicStatus, targetOf } from "./channel.mjs";
import { OUTCOME } from "./confirm.mjs";
import { DECISION } from "../../approvals/broker.mjs";

const silent = { info: function () {}, warn: function () {}, error: function () {} };

test("decisionForOutcome 只把明确决策交给 broker", () => {
  assert.equal(decisionForOutcome(OUTCOME.ALLOW), DECISION.ALLOW_ONCE);
  assert.equal(decisionForOutcome(OUTCOME.REJECT), DECISION.REJECT_ONCE);
  assert.equal(decisionForOutcome(OUTCOME.TIMEOUT), null);
  assert.equal(decisionForOutcome(OUTCOME.CANCEL), null);
  assert.equal(decisionForOutcome(OUTCOME.DEFER), null);
  assert.equal(decisionForOutcome("busy"), null);
});

test("parseMicStatus 认 AVAuthorizationStatus 的 rawValue", () => {
  assert.equal(parseMicStatus("AVAuthorizationStatus(rawValue: 0)"), 0);
  assert.equal(parseMicStatus("AVAuthorizationStatus(rawValue: 3)"), 3);
  assert.equal(parseMicStatus("nope"), null);
  assert.equal(parseMicStatus(null), null);
});

test("targetOf 从工具入参里取目标", () => {
  assert.equal(targetOf({ toolInput: { command: "rm -rf build" } }), "rm -rf build");
  assert.equal(targetOf({ toolInput: { file_path: "src/app.js" } }), "src/app.js");
  assert.equal(targetOf({ title: "执行命令" }), "执行命令");
  assert.equal(targetOf(null), "");
});

test("checkVoiceReady 缺文件时直接判不可用", async () => {
  const result = await checkVoiceReady({
    bridge: "/nonexistent/bridge",
    whisperBinary: "/nonexistent/whisper",
    model: "/nonexistent/model",
  });
  assert.equal(result.ready, false);
  assert.match(result.reason, /缺少/);
});

const selfPath = fileURLToPath(new URL("./channel.mjs", import.meta.url));

test("checkVoiceReady 读 app 自检：已授权", async () => {
  const result = await checkVoiceReady({
    bridge: selfPath,
    whisperBinary: selfPath,
    model: selfPath,
    selftest: function () { return { micAuthorization: "AVAuthorizationStatus(rawValue: 3)" }; },
  });
  assert.equal(result.ready, true);
  assert.equal(result.micStatus, 3);
});

test("checkVoiceReady 读 app 自检：被拒绝就关掉", async () => {
  const result = await checkVoiceReady({
    bridge: selfPath,
    whisperBinary: selfPath,
    model: selfPath,
    selftest: function () { return { micAuthorization: "AVAuthorizationStatus(rawValue: 2)" }; },
  });
  assert.equal(result.ready, false);
  assert.equal(result.micStatus, 2);
});

test("checkVoiceReady：notDetermined 仍允许启动，首次会弹窗", async () => {
  const result = await checkVoiceReady({
    bridge: selfPath,
    whisperBinary: selfPath,
    model: selfPath,
    selftest: function () { return { micAuthorization: "AVAuthorizationStatus(rawValue: 0)" }; },
  });
  assert.equal(result.ready, true);
  assert.equal(result.micStatus, 0);
});

function approvalItem() {
  return {
    id: "pending-1",
    payload: {
      agent: "claude",
      agentLabel: "Claude Code",
      toolName: "Bash",
      toolInput: { command: "ls -la" },
    },
  };
}

test("handle：口令正确时返回 allow", async () => {
  const said = [];
  const channel = createVoiceChannel({
    log: silent,
    speaker: async function (text) { said.push(text); },
    listener: async function () { return { ok: true, text: "四七二九", confidence: 0.9 }; },
    nonceFactory: function () { return "4729"; },
    timeoutMs: 1000,
  });
  const result = await channel.handle(approvalItem());
  assert.equal(result.outcome, OUTCOME.ALLOW);
  assert.ok(said.some(function (line) { return line.includes("4 7 2 9"); }));
});

test("handle：拒绝不需要口令", async () => {
  const channel = createVoiceChannel({
    log: silent,
    speaker: async function () {},
    listener: async function () { return { ok: true, text: "拒绝", confidence: 0.9 }; },
    nonceFactory: function () { return "4729"; },
    timeoutMs: 1000,
  });
  const result = await channel.handle(approvalItem());
  assert.equal(result.outcome, OUTCOME.REJECT);
});

test("handle：同一时间只处理一个请求", async () => {
  let release;
  const channel = createVoiceChannel({
    log: silent,
    speaker: async function () {},
    listener: function () {
      return new Promise(function (resolve) { release = resolve; });
    },
    nonceFactory: function () { return "4729"; },
    timeoutMs: 1000,
    maxAttempts: 1,
  });
  const first = channel.handle(approvalItem());
  await new Promise(function (resolve) { setImmediate(resolve); });
  const second = await channel.handle(approvalItem());
  assert.equal(second.outcome, "busy");
  release({ ok: true, text: "四七二九", confidence: 0.9 });
  const result = await first;
  assert.equal(result.outcome, OUTCOME.ALLOW);
});

test("test：语音测试走同一套口令确认", async () => {
  const said = [];
  const channel = createVoiceChannel({
    log: silent,
    speaker: async function (text) { said.push(text); },
    listener: async function () { return { ok: true, text: "四七二九", confidence: 0.9 }; },
    nonceFactory: function () { return "4729"; },
    timeoutMs: 1000,
  });
  const result = await channel.test();
  assert.equal(result.outcome, OUTCOME.ALLOW);
  assert.ok(said.some(function (line) { return line.includes("语音测试"); }));
});

test("stop 后不再接新请求", async () => {
  const channel = createVoiceChannel({
    log: silent,
    speaker: async function () {},
    listener: async function () { return { ok: true, text: "拒绝", confidence: 0.9 }; },
    nonceFactory: function () { return "4729"; },
  });
  channel.stop();
  const result = await channel.handle(approvalItem());
  assert.equal(result.outcome, "stopped");
});
