import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDingTalkBot } from "./dingtalk-bot.mjs";
import { createUsageStore } from "./dingtalk-usage.mjs";
import { DECISION } from "../approvals/broker.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-dingtalk-"));
}

function jsonResponse(body, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const entry = { url: String(url), init };
    calls.push(entry);
    return handler(entry);
  };
  impl.calls = calls;
  return impl;
}

function fakeStreamFactory() {
  const state = { onMessage: null, started: false, acked: [] };
  state.factory = (opts) => {
    state.onMessage = opts.onMessage;
    return {
      async start() { state.started = true; },
      stop() { state.started = false; },
      ack(messageId) { state.acked.push(messageId); },
      isConnected() { return true; },
      getStatus() { return "connected"; },
    };
  };
  return state;
}

function writeBinding(file, overrides) {
  fs.writeFileSync(file, JSON.stringify(Object.assign({
    userId: "u1",
    conversationId: "c1",
    conversationType: 1,
    robotCode: "bot",
    boundAt: Date.now(),
  }, overrides || {})));
}

function makeBot(opts) {
  const dir = opts.dir || tempDir();
  const bindingFile = path.join(dir, "dingtalk.json");
  if (opts.binding !== false) writeBinding(bindingFile, opts.bindingOverrides);
  const usage = createUsageStore({
    file: path.join(dir, "usage.json"),
    now: opts.now || (() => Date.now()),
    saveDebounceMs: 100000,
    monthlyLimit: 100,
  });
  const stream = fakeStreamFactory();
  const brokerCalls = [];
  const broker = {
    list: () => (opts.pending || []),
    decide: (id, decision) => { brokerCalls.push({ id, decision }); return opts.decideResult !== false; },
  };
  const bot = createDingTalkBot({
    config: {
      type: "dingtalk-bot",
      clientId: "ding-client",
      clientSecret: "ding-secret",
      robotCode: "bot",
      target: { mode: "dm", userId: "u1" },
      events: { approval: true, question: true, error: true, completed: false },
      severityMin: "critical",
      usage: { monthlyLimit: 100, warnAt: 0.8, confirmOnlyAt: 1, hardStopAt: 1.2 },
      binding: { requireConfirm: true },
      audit: false,
      ...(opts.config || {}),
    },
    log: { info() {}, warn() {}, debug() {} },
    usage,
    broker,
    streamFactory: stream.factory,
    fetchImpl: opts.fetchImpl,
    bindingFile,
    auditFile: path.join(dir, "audit.log"),
    now: opts.now,
  });
  return { bot, usage, stream, brokerCalls, dir, bindingFile };
}

function inbound(text, overrides) {
  return {
    headers: { messageId: "m-" + Math.random().toString(16).slice(2) },
    data: JSON.stringify(Object.assign({
      msgId: "msg-" + Math.random().toString(16).slice(2),
      senderStaffId: "u1",
      senderNick: "我",
      conversationId: "c1",
      conversationType: "1",
      robotCode: "bot",
      sessionWebhook: "https://session.example/send",
      sessionWebhookExpiredTime: Date.now() + 3600000,
      text: { content: text },
    }, overrides || {})),
  };
}

test("accepts：只放行已绑定、已开启且达到严重级的事件", async () => {
  const { bot } = makeBot({});
  assert.equal(bot.accepts({ kind: "approval", severity: "critical" }), true);
  assert.equal(bot.accepts({ kind: "completed", severity: "normal" }), false);
  assert.equal(bot.accepts({ kind: "error", severity: "normal" }), false);
  assert.equal(bot.accepts({ kind: "error", severity: "critical" }), true);
});

test("固定文本：批准 <ID> 生效，少空格/小写不生效", async () => {
  const { bot, stream, brokerCalls } = makeBot({
    pending: [{ id: "a3f2b7c1-0000-4000-8000-000000000000", kind: "approval" }],
    fetchImpl: fakeFetch((entry) => {
      if (entry.url.includes("oauth2/accessToken")) return jsonResponse({ accessToken: "t", expireIn: 7200 });
      if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
      if (entry.url.includes("session.example")) return jsonResponse({ errcode: 0 });
      if (entry.url.includes("oToMessages") || entry.url.includes("groupMessages")) return jsonResponse({ processQueryKey: "p" });
      return jsonResponse({});
    }),
  });
  await bot.start();

  await bot.send({ kind: "approval", severity: "critical", title: "授权请求", body: "执行测试", eventId: "a3f2b7c1-0000-4000-8000-000000000000" });

  const sendCall = bot.usage.snapshot();
  assert.equal(sendCall.billable.total, 1);

  // 短 ID 由 eventId 生成，前 4 位是 A3F2
  await stream.onMessage(inbound("批准 A3F2"));
  assert.equal(brokerCalls.length, 1);
  assert.equal(brokerCalls[0].decision, DECISION.ALLOW_ONCE);

  await stream.onMessage(inbound("批准A3F2"));
  await stream.onMessage(inbound("批准 a3f2"));
  assert.equal(brokerCalls.length, 1);
});

test("首次绑定：waiting → 首条消息 → 桌面确认 → bound", async () => {
  const { bot, stream, bindingFile } = makeBot({
    binding: false,
    fetchImpl: fakeFetch((entry) => {
      if (entry.url.includes("oauth2/accessToken")) return jsonResponse({ accessToken: "t", expireIn: 7200 });
      if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
      if (entry.url.includes("session.example")) return jsonResponse({ errcode: 0 });
      if (entry.url.includes("oToMessages")) return jsonResponse({ processQueryKey: "p" });
      return jsonResponse({});
    }),
  });
  await bot.start();
  assert.equal(bot.startBinding().ok, true);
  await stream.onMessage(inbound("hi"));
  assert.equal(bot.getState().binding.state, "pending_confirm");
  assert.equal(await bot.confirmBinding(), true);
  assert.equal(bot.getState().binding.state, "bound");
  assert.ok(fs.existsSync(bindingFile));
});

test("dedupe：同一个 msgId 只处理一次", async () => {
  const { bot, stream, brokerCalls } = makeBot({
    pending: [{ id: "a3f2b7c1-0000-4000-8000-000000000000", kind: "approval" }],
    fetchImpl: fakeFetch((entry) => {
      if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
      if (entry.url.includes("session.example")) return jsonResponse({ errcode: 0 });
      return jsonResponse({});
    }),
  });
  await bot.start();
  const frame = inbound("批准 A3F2", { msgId: "same" });
  await stream.onMessage(frame);
  await stream.onMessage(frame);
  assert.equal(brokerCalls.length, 1);
});

test("配额错误：标记 exhausted 并停止出站", async () => {
  const { bot, usage } = makeBot({
    fetchImpl: fakeFetch((entry) => {
      if (entry.url.includes("oauth2/accessToken") || entry.url.includes("gettoken")) {
        return jsonResponse({ accessToken: "t", access_token: "o", expireIn: 7200, expires_in: 7200 });
      }
      if (entry.url.includes("oToMessages")) return jsonResponse({ code: "quota.exceed", message: "quota exceeded" }, 403);
      return jsonResponse({});
    }),
  });
  await bot.start();
  const sent = await bot.send({ kind: "approval", severity: "critical", title: "x", body: "y", eventId: "id" });
  assert.equal(sent, false);
  assert.equal(usage.isQuotaExhausted(), true);
  assert.equal(bot.accepts({ kind: "approval", severity: "critical" }), false);
});
