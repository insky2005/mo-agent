import test from "node:test";
import assert from "node:assert/strict";
import { OUTCOME, listenOnce, runVoiceConfirm } from "./confirm.mjs";
import { buildApprovalDraft, buildDictationDraft } from "./text.mjs";

function makeIo(script) {
  const said = [];
  const queue = script.slice();
  return {
    said,
    async speak(text) {
      said.push(text);
    },
    async listen() {
      if (!queue.length) return { ok: false, error: "timeout" };
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function approvalDraft() {
  return buildApprovalDraft({
    agentLabel: "Claude",
    toolName: "Bash",
    target: "rm -rf build",
    nonce: "4729",
  });
}

test("授权：口令正确才放行", async () => {
  const io = makeIo([{ ok: true, text: "四七二九", confidence: 0.9 }]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729" });
  assert.equal(result.outcome, OUTCOME.ALLOW);
  assert.equal(result.attempts, 1);
  assert.ok(io.said[0].includes("4 7 2 9"));
  assert.ok(io.said.includes("已批准。"));
});

test("授权：口令错一次、第二次正确", async () => {
  const io = makeIo([
    { ok: true, text: "四七二八", confidence: 0.9 },
    { ok: true, text: "四七二九", confidence: 0.9 },
  ]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729" });
  assert.equal(result.outcome, OUTCOME.ALLOW);
  assert.equal(result.attempts, 2);
  assert.ok(io.said.some((line) => line.includes("口令不对")));
});

test("授权：只说同意、不给口令，不放行", async () => {
  const io = makeIo([
    { ok: true, text: "同意", confidence: 0.9 },
    { ok: true, text: "同意", confidence: 0.9 },
  ]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729", maxAttempts: 2 });
  assert.equal(result.outcome, OUTCOME.DEFER);
  assert.ok(!io.said.includes("已批准。"));
});

test("授权：拒绝直接生效，且不需要口令", async () => {
  const io = makeIo([{ ok: true, text: "拒绝", confidence: 0.9 }]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729" });
  assert.equal(result.outcome, OUTCOME.REJECT);
  assert.ok(io.said.includes("已拒绝。"));
});

test("授权：低置信度永不返回 ALLOW", async () => {
  const io = makeIo([
    { ok: true, text: "四七二九", confidence: 0.1 },
    { ok: true, text: "四七二九", confidence: 0.1 },
  ]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729", maxAttempts: 2 });
  assert.equal(result.outcome, OUTCOME.DEFER);
  assert.ok(!io.said.includes("已批准。"));
});

test("最后一次口令错：明确结束，不再邀请复述", async () => {
  const io = makeIo([{ ok: true, text: "1111", confidence: 0.9 }]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729", maxAttempts: 1 });
  assert.equal(result.outcome, OUTCOME.DEFER);
  const last = io.said[io.said.length - 1];
  assert.ok(last.includes("已结束语音确认"), "最后一句应明确结束: " + last);
  assert.ok(!last.includes("请复述"), "最后一句不应再邀请复述: " + last);
});

test("授权：麦克风被拒绝时直接交回手机", async () => {
  const io = makeIo([{ ok: false, error: "mic-denied" }]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729" });
  assert.equal(result.outcome, OUTCOME.DEFER);
  assert.equal(result.error, "mic-denied");
  assert.ok(io.said.some((line) => line.includes("麦克风不可用") && line.includes("已结束")));
  assert.ok(!io.said.includes("已批准。"));
});

test("授权：超时交回，不放行", async () => {
  const io = makeIo([{ ok: false, error: "timeout" }]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729" });
  assert.equal(result.outcome, OUTCOME.TIMEOUT);
  assert.ok(!io.said.includes("已批准。"));
});

test("授权：识别异常后重试成功", async () => {
  const io = makeIo([
    new Error("mic exploded"),
    { ok: true, text: "四七二九", confidence: 0.9 },
  ]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729" });
  assert.equal(result.outcome, OUTCOME.ALLOW);
  assert.equal(result.attempts, 2);
});

test("重复：重念草稿但不丢弃", async () => {
  const io = makeIo([
    { ok: true, text: "重复", confidence: 0.9 },
    { ok: true, text: "四七二九", confidence: 0.9 },
  ]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729", maxAttempts: 3 });
  assert.equal(result.outcome, OUTCOME.ALLOW);
  const prompts = io.said.filter((line) => line.includes("复述口令"));
  assert.equal(prompts.length, 2);
});

test("重说：丢弃草稿，返回 RETRY", async () => {
  const io = makeIo([{ ok: true, text: "重说", confidence: 0.9 }]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729" });
  assert.equal(result.outcome, OUTCOME.RETRY);
  assert.ok(io.said.includes("已丢弃，请重新说。"));
});

test("口述：确认发送才放行", async () => {
  const draft = buildDictationDraft({ text: "把登录页改成深色" });
  const io = makeIo([{ ok: true, text: "确认发送", confidence: 0.9 }]);
  const result = await runVoiceConfirm({ draft, io });
  assert.equal(result.outcome, OUTCOME.ALLOW);
  assert.ok(io.said.includes("已发送。"));
});

test("口述：含糊应答不放行", async () => {
  const draft = buildDictationDraft({ text: "把登录页改成深色" });
  const io = makeIo([
    { ok: true, text: "嗯", confidence: 0.9 },
    { ok: true, text: "好的", confidence: 0.9 },
  ]);
  const result = await runVoiceConfirm({ draft, io, maxAttempts: 2 });
  assert.equal(result.outcome, OUTCOME.DEFER);
  assert.ok(!io.said.includes("已发送。"));
});

test("口述：取消不发", async () => {
  const draft = buildDictationDraft({ text: "把登录页改成深色" });
  const io = makeIo([{ ok: true, text: "取消", confidence: 0.9 }]);
  const result = await runVoiceConfirm({ draft, io });
  assert.equal(result.outcome, OUTCOME.CANCEL);
  assert.ok(!io.said.includes("已发送。"));
});

test("空转写不算确认", async () => {
  const io = makeIo([
    { ok: true, text: "   ", confidence: 0.99 },
    { ok: true, text: "四七二九", confidence: 0.9 },
  ]);
  const result = await runVoiceConfirm({ draft: approvalDraft(), io, nonce: "4729" });
  assert.equal(result.outcome, OUTCOME.ALLOW);
  assert.equal(result.attempts, 2);
});

test("listenOnce：一次监听返回文本、置信度与低置信度标记", async () => {
  const result = await listenOnce({ io: { listen: async function () { return { ok: true, text: "确认", confidence: 0.2 }; } } });
  assert.equal(result.ok, true);
  assert.equal(result.text, "确认");
  assert.equal(result.confidence, 0.2);
  assert.equal(result.lowConfidence, true);
});

test("listenOnce：监听异常归一成 ok:false", async () => {
  const result = await listenOnce({ io: { listen: async function () { throw new Error("mic exploded"); } } });
  assert.equal(result.ok, false);
  assert.match(result.error, /listen-failed:mic exploded/);
});

test("listenOnce：超时原样返回 error", async () => {
  const result = await listenOnce({ io: { listen: async function () { return { ok: false, error: "timeout" }; } } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "timeout");
});

