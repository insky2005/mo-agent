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
      aggregateMs: 0,
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

test("固定文本：A/D + 短码生效，非法格式不生效", async () => {
  const fetchImpl = fakeFetch((entry) => {
    if (entry.url.includes("oauth2/accessToken")) return jsonResponse({ accessToken: "t", expireIn: 7200 });
    if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
    if (entry.url.includes("session.example")) return jsonResponse({ errcode: 0 });
    if (entry.url.includes("oToMessages") || entry.url.includes("groupMessages")) return jsonResponse({ processQueryKey: "p" });
    return jsonResponse({});
  });
  const { bot, stream, brokerCalls } = makeBot({
    pending: [
      { id: "a3f2b7c1-0000-4000-8000-000000000000", kind: "approval" },
      { id: "b7c1d2e3-0000-4000-8000-000000000000", kind: "approval" },
    ],
    fetchImpl,
  });
  await bot.start();

  await bot.send({ kind: "approval", severity: "critical", title: "授权请求", body: "执行测试", eventId: "a3f2b7c1-0000-4000-8000-000000000000" });
  await bot.send({ kind: "approval", severity: "critical", title: "授权请求", body: "执行测试 2", eventId: "b7c1d2e3-0000-4000-8000-000000000000" });

  const sendCall = fetchImpl.calls.find((entry) => entry.url.includes("oToMessages"));
  assert.ok(sendCall, "应该发送过审批消息");
  const sentText = JSON.parse(JSON.parse(sendCall.init.body).msgParam).text;
  assert.match(sentText, /#A3F2/);
  assert.match(sentText, /回复：A A3F2 同意/);

  // 非法格式不调用 broker
  await stream.onMessage(inbound("同意 A3F2"));
  await stream.onMessage(inbound("A3F2"));
  await stream.onMessage(inbound("A A3F2 谢谢"));
  assert.equal(brokerCalls.length, 0);

  // 无空格、小写都可以
  await stream.onMessage(inbound("AA3F2"));
  assert.equal(brokerCalls.length, 1);
  assert.equal(brokerCalls[0].decision, DECISION.ALLOW_ONCE);

  await stream.onMessage(inbound("d b7c1"));
  assert.equal(brokerCalls.length, 2);
  assert.equal(brokerCalls[1].decision, DECISION.REJECT_ONCE);
});

function sentMessages(fetchImpl) {
  return fetchImpl.calls
    .filter((entry) => entry.url.includes("oToMessages"))
    .map((entry) => {
      const body = JSON.parse(entry.init.body);
      const param = JSON.parse(body.msgParam);
      return { msgKey: body.msgKey, text: param.text || param.content || "" };
    });
}

test("copyHints=code：主消息 + 只有短码的一条", async () => {
  const fetchImpl = fakeFetch((entry) => {
    if (entry.url.includes("oauth2/accessToken")) return jsonResponse({ accessToken: "t", expireIn: 7200 });
    if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
    if (entry.url.includes("oToMessages")) return jsonResponse({ processQueryKey: "p" });
    return jsonResponse({});
  });
  const { bot } = makeBot({
    fetchImpl,
    config: { copyHints: "code", aggregateMs: 0 },
    pending: [{ id: "a3f2b7c1-0000-4000-8000-000000000000", kind: "approval" }],
  });
  await bot.start();
  await bot.send({ kind: "approval", severity: "critical", title: "授权请求", body: "执行测试", eventId: "a3f2b7c1-0000-4000-8000-000000000000" });

  const sent = sentMessages(fetchImpl);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].msgKey, "sampleMarkdown");
  assert.match(sent[1].text, /^[0-9A-F]{4,6}$/);
});

test("copyHints=actions：主消息 + A/D 短码；一条回复可处理多个短码", async () => {
  const fetchImpl = fakeFetch((entry) => {
    if (entry.url.includes("oauth2/accessToken")) return jsonResponse({ accessToken: "t", expireIn: 7200 });
    if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
    if (entry.url.includes("oToMessages")) return jsonResponse({ processQueryKey: "p" });
    if (entry.url.includes("session.example")) return jsonResponse({ errcode: 0 });
    return jsonResponse({});
  });
  const { bot, stream, brokerCalls } = makeBot({
    fetchImpl,
    config: { copyHints: "actions", aggregateMs: 0 },
    pending: [
      { id: "a3f2b7c1-0000-4000-8000-000000000000", kind: "approval" },
      { id: "b7c1d2e3-0000-4000-8000-000000000000", kind: "approval" },
    ],
  });
  await bot.start();
  await bot.send({ kind: "approval", severity: "critical", title: "授权请求", body: "执行测试", eventId: "a3f2b7c1-0000-4000-8000-000000000000" });
  await bot.send({ kind: "approval", severity: "critical", title: "授权请求", body: "执行测试 2", eventId: "b7c1d2e3-0000-4000-8000-000000000000" });

  const sent = sentMessages(fetchImpl);
  assert.equal(sent.length, 6); // 每个审批：主消息 + A 短码 + D 短码
  assert.equal(sent.filter((item) => item.msgKey === "sampleMarkdown").length, 2);
  const codes = sent
    .filter((item) => item.msgKey === "sampleText")
    .map((item) => /^A ([0-9A-F]{4,6})$/.exec(item.text))
    .filter(Boolean)
    .map((match) => match[1]);
  assert.equal(codes.length, 2);

  // 直接回复聚合后的「A 短码 短码」，两条审批一起放行。
  await stream.onMessage(inbound("A " + codes.join(" ")));
  assert.equal(brokerCalls.length, 2);
  assert.ok(brokerCalls.every((call) => call.decision === DECISION.ALLOW_ONCE));
});

function lastSessionReply(fetchImpl) {
  const calls = fetchImpl.calls.filter((entry) => entry.url.includes("session.example"));
  const body = JSON.parse(calls[calls.length - 1].init.body);
  return body.markdown;
}

test("回复格式：授权确认 [Agent] + #短码 已同意", async () => {
  const fetchImpl = fakeFetch((entry) => {
    if (entry.url.includes("oauth2/accessToken")) return jsonResponse({ accessToken: "t", expireIn: 7200 });
    if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
    if (entry.url.includes("oToMessages")) return jsonResponse({ processQueryKey: "p" });
    if (entry.url.includes("session.example")) return jsonResponse({ errcode: 0 });
    return jsonResponse({});
  });
  const { bot, stream } = makeBot({
    fetchImpl,
    config: { aggregateMs: 0 },
    pending: [{ id: "a3f2b7c1-0000-4000-8000-000000000000", kind: "approval" }],
  });
  await bot.start();
  await bot.send({ kind: "approval", severity: "critical", agentLabel: "Qoder CN", title: "授权请求", body: "执行测试", eventId: "a3f2b7c1-0000-4000-8000-000000000000" });
  const main = sentMessages(fetchImpl).find((item) => item.msgKey === "sampleMarkdown");
  const code = /#([0-9A-F]{4,6})/.exec(main.text)[1];

  await stream.onMessage(inbound("A " + code));
  const reply = lastSessionReply(fetchImpl);
  assert.equal(reply.title, "授权确认 [Qoder CN]");
  assert.equal(reply.text, "授权确认 [Qoder CN]\n\n#" + code + " 已同意");
});

test("回复格式：已结束的审批显示 #短码 已处理（已结束）", async () => {
  const fetchImpl = fakeFetch((entry) => {
    if (entry.url.includes("oauth2/accessToken")) return jsonResponse({ accessToken: "t", expireIn: 7200 });
    if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
    if (entry.url.includes("oToMessages")) return jsonResponse({ processQueryKey: "p" });
    if (entry.url.includes("session.example")) return jsonResponse({ errcode: 0 });
    return jsonResponse({});
  });
  const { bot, stream } = makeBot({
    fetchImpl,
    decideResult: false,
    config: { aggregateMs: 0 },
    pending: [{ id: "a3f2b7c1-0000-4000-8000-000000000000", kind: "approval", agentLabel: "Qoder CN" }],
  });
  await bot.start();
  await bot.send({ kind: "approval", severity: "critical", agentLabel: "Qoder CN", title: "授权请求", body: "执行测试", eventId: "a3f2b7c1-0000-4000-8000-000000000000" });
  const main = sentMessages(fetchImpl).find((item) => item.msgKey === "sampleMarkdown");
  const code = /#([0-9A-F]{4,6})/.exec(main.text)[1];

  await stream.onMessage(inbound("A " + code));
  const reply = lastSessionReply(fetchImpl);
  assert.equal(reply.title, "授权确认 [Qoder CN]");
  assert.equal(reply.text, "授权确认 [Qoder CN]\n\n#" + code + " 已处理（请确认是否重复处理或在其他终端已处理）");
});

test("配对码绑定：错误码不绑定，正确码立即绑定", async () => {
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
  const started = bot.startBinding();
  assert.equal(started.ok, true);
  assert.match(started.code, /^\d{6}$/);
  assert.equal(bot.getState().binding.code, started.code);

  const wrong = started.code === "000000" ? "111111" : "000000";
  await stream.onMessage(inbound(wrong));
  assert.equal(bot.getState().binding.state, "waiting");

  await stream.onMessage(inbound(started.code));
  assert.equal(bot.getState().binding.state, "bound");
  assert.ok(fs.existsSync(bindingFile));
});

test("startBinding：可接管预生成配对码", async () => {
  const { bot } = makeBot({ binding: false });
  const started = bot.startBinding({ code: "123456", expiresAt: 999 });
  assert.equal(started.code, "123456");
  assert.equal(started.expiresAt, 999);
  assert.equal(bot.getState().binding.code, "123456");
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
  const frame = inbound("A A3F2", { msgId: "same" });
  await stream.onMessage(frame);
  await stream.onMessage(frame);
  assert.equal(brokerCalls.length, 1);
});

test("聚合：同会话同 kind 的多条合并成 1 次发送", async () => {
  const fetchImpl = fakeFetch((entry) => {
    if (entry.url.includes("oauth2/accessToken")) return jsonResponse({ accessToken: "t", expireIn: 7200 });
    if (entry.url.includes("gettoken")) return jsonResponse({ access_token: "o", expires_in: 7200 });
    if (entry.url.includes("oToMessages")) return jsonResponse({ processQueryKey: "p" });
    return jsonResponse({});
  });
  const { bot, usage } = makeBot({ config: { aggregateMs: 40 }, fetchImpl });
  await bot.start();
  await bot.send({ kind: "approval", severity: "critical", title: "授权请求", body: "执行 A", eventId: "a3f2b7c1-0000", sessionId: "s1", sessionTitle: "proj-x" });
  await bot.send({ kind: "approval", severity: "critical", title: "授权请求", body: "执行 B", eventId: "b7c1d2e3-0000", sessionId: "s1", sessionTitle: "proj-x" });
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(usage.snapshot().billable.total, 1);
  const calls = fetchImpl.calls.filter((item) => item.url.includes("oToMessages"));
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  const text = JSON.parse(body.msgParam).text;
  assert.match(text, /A3F2/);
  assert.match(text, /B7C1/);
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
