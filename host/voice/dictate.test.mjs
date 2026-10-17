import test from "node:test";
import assert from "node:assert/strict";
import { createDictationRunner } from "./dictate.mjs";
import { buildDictationDraft, isDictationConfirm } from "./text.mjs";

const silent = { info: function () {}, warn: function () {}, debug: function () {} };

function makeHub(list) {
  const map = new Map(list.map(function (session) { return [session.id, session]; }));
  return {
    list: function () { return list.slice(); },
    get: function (id) { return map.get(id) || null; },
  };
}

function session(id, overrides) {
  return Object.assign({ id: id, title: id, status: "running", running: true }, overrides || {});
}

function harness(config) {
  const opts = config || {};
  const said = [];
  const events = [];
  const sends = [];
  const trace = [];
  const listenInputs = [];
  const queue = (opts.script || []).slice();
  let focusCalls = 0;

  const listen = async function (input) {
    listenInputs.push(input || {});
    if (!queue.length) return { ok: false, error: "timeout" };
    const next = queue.shift();
    if (typeof next === "function") return next(input);
    if (next instanceof Error) throw next;
    if (typeof next === "string") return { ok: true, text: next, confidence: 0.95 };
    return next;
  };

  const runner = createDictationRunner({
    hub: makeHub(opts.sessions || [session("a", { title: "账号页" })]),
    getTargetSessionId: function () {
      focusCalls += 1;
      if (typeof opts.focus === "function") return opts.focus(focusCalls);
      return opts.focus === undefined ? null : opts.focus;
    },
    sendPrompt: async function (sessionId, text) {
      sends.push({ sessionId: sessionId, text: text });
      if (opts.sendError) throw opts.sendError;
      if (opts.sendResult) return opts.sendResult;
      return { ok: true };
    },
    listen: opts.listen || listen,
    speak: async function (text) {
      said.push(text);
      trace.push({ type: "speak", text: text });
    },
    prepare: async function () { return { ok: true }; },
    onEvent: function (event) {
      events.push(event);
      trace.push({ type: "event", phase: event.phase });
    },
    log: silent,
    listenDelayMs: opts.listenDelayMs === undefined ? 0 : opts.listenDelayMs,
    resultDelayMs: 0,
    maxChars: opts.maxChars,
    maxAttempts: opts.maxAttempts,
    confirmAttempts: opts.confirmAttempts,
  });

  return { runner: runner, said: said, events: events, sends: sends, trace: trace, listenInputs: listenInputs, queue: queue };
}

test("isDictationConfirm 只认明确的发送/发布动作", () => {
  for (const text of ["确认发送", "发送", "确认发布", "确认发送任务", "確認發送", "发送。"]) {
    assert.equal(isDictationConfirm(text), true, text + " 应放行");
  }
  for (const text of ["同意", "确定", "好", "好的", "可以", "批准", "嗯", "确认", ""]) {
    assert.equal(isDictationConfirm(text), false, text + " 不应放行");
  }
});

test("buildDictationDraft：短句全文、长句前 40 字 + 总字数，并念出目标", () => {
  const short = buildDictationDraft({ text: "把登录页改成深色", targetTitle: "账号页" });
  assert.ok(short.prompt.startsWith("发给「账号页」。"));
  assert.ok(short.prompt.includes("把登录页改成深色"));
  assert.ok(short.prompt.endsWith("确认发送吗？"));

  const long = buildDictationDraft({ text: "字".repeat(45), targetTitle: "账号页" });
  assert.ok(long.prompt.includes("共45个字"));
  assert.ok(long.prompt.includes("字".repeat(40)));
  assert.ok(!long.prompt.includes("字".repeat(41)));
});

test("resolveTarget：有焦点且在线时用焦点", () => {
  const h = harness({ sessions: [session("a", { title: "账号页" }), session("b")], focus: "a" });
  const target = h.runner.resolveTarget();
  assert.equal(target.ok, true);
  assert.equal(target.source, "focus");
  assert.equal(target.session.id, "a");
  assert.equal(target.title, "账号页");
});

test("resolveTarget：没有焦点但恰好一个活跃会话时自动选", () => {
  const h = harness({
    sessions: [session("a", { title: "账号页" }), session("done", { status: "done", running: false })],
    focus: null,
  });
  const target = h.runner.resolveTarget();
  assert.equal(target.ok, true);
  assert.equal(target.source, "single-active");
  assert.equal(target.session.id, "a");
});

test("resolveTarget：多个活跃会话不猜，列候选", () => {
  const h = harness({ sessions: [session("a"), session("b")], focus: null });
  const target = h.runner.resolveTarget();
  assert.equal(target.ok, false);
  assert.equal(target.action, "ambiguous");
  assert.equal(target.candidates.length, 2);
  assert.match(target.reply, /切到第几个/);
});

test("resolveTarget：零个活跃会话不发送", () => {
  const h = harness({ sessions: [session("a", { status: "done", running: false })], focus: null });
  const target = h.runner.resolveTarget();
  assert.equal(target.ok, false);
  assert.equal(target.action, "no-target");
  assert.match(target.reply, /没有明确的发送目标/);
});

test("resolveTarget：焦点会话离线不发送，列活跃候选", () => {
  const h = harness({ sessions: [session("a"), session("b")], focus: "gone" });
  const target = h.runner.resolveTarget();
  assert.equal(target.ok, false);
  assert.equal(target.action, "target-offline");
  assert.equal(target.candidates.length, 2);
  assert.match(target.reply, /已离线/);
});

test("口述全流程：草稿 → 回读 → 确认发送，只调用一次 sendPrompt", async () => {
  const h = harness({ focus: "a", script: ["把登录页改成深色", "确认发送"] });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, true);
  assert.equal(result.action, "sent");
  assert.equal(result.target.id, "a");
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].sessionId, "a");
  assert.equal(h.sends[0].text, "把登录页改成深色");
  assert.ok(h.said.some(function (line) { return line.includes("发给「账号页」"); }));
  assert.ok(h.said.some(function (line) { return line === "已发送给「账号页」。"; }));

  const phases = h.events.map(function (event) { return event.phase; });
  assert.ok(phases.indexOf("draft") < phases.indexOf("confirm"), "draft 必须先于 confirm");
  const resultIndex = h.trace.findIndex(function (item) { return item.type === "event" && item.phase === "result"; });
  const sentSpeakIndex = h.trace.findIndex(function (item) { return item.type === "speak" && item.text === "已发送给「账号页」。"; });
  assert.ok(resultIndex >= 0 && resultIndex < sentSpeakIndex, "result 事件必须先于 TTS");
});

test("口述：泛化确认「同意」「确定」不能发送", async () => {
  const h = harness({
    focus: "a",
    confirmAttempts: 2,
    script: ["把登录页改成深色", "同意", "确定"],
  });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(h.sends.length, 0);
  assert.ok(!h.said.includes("已发送给「账号页」。"));
});

test("口述：说「重说」丢弃草稿并重录一次", async () => {
  const h = harness({
    focus: "a",
    script: ["第一版内容", "重说", "第二版内容", "确认发送"],
  });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, true);
  assert.equal(result.action, "sent");
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].text, "第二版内容");
  const drafts = h.events.filter(function (event) { return event.phase === "draft"; });
  assert.equal(drafts.length, 2);
  assert.ok(h.said.includes("已丢弃，请重新说。"));
});

test("口述：最多重说一次，第二次重说不发送", async () => {
  const h = harness({
    focus: "a",
    script: ["第一版内容", "重说", "第二版内容", "重说"],
  });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.action, "retry-limit");
  assert.equal(h.sends.length, 0);
});

test("口述：说「取消」丢弃且不发送", async () => {
  const h = harness({ focus: "a", script: ["把登录页改成深色", "取消"] });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.action, "cancel");
  assert.equal(h.sends.length, 0);
  assert.ok(h.said.includes("已取消，未发送。"));
});

test("口述：确认阶段超时不发送", async () => {
  const h = harness({
    focus: "a",
    script: ["把登录页改成深色", { ok: false, error: "timeout" }],
  });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.action, "timeout");
  assert.equal(h.sends.length, 0);
});

test("口述：空文本不发送", async () => {
  const h = harness({ focus: "a", script: [{ ok: true, text: "   ", confidence: 0.9 }] });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.action, "empty");
  assert.equal(h.sends.length, 0);
});

test("口述：低置信度不发送", async () => {
  const h = harness({
    focus: "a",
    script: [{ ok: true, text: "把登录页改成深色", confidence: 0.1 }],
  });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.action, "low-confidence");
  assert.equal(h.sends.length, 0);
});

test("口述：超过 maxChars 不发送", async () => {
  const h = harness({ focus: "a", maxChars: 5, script: ["这是一段明显超过五个字的内容"] });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.action, "too-long");
  assert.equal(h.sends.length, 0);
});

test("口述：目标不明确时不发送，也不进入确认", async () => {
  const h = harness({
    sessions: [session("a"), session("b")],
    focus: null,
    script: ["把登录页改成深色", "确认发送"],
  });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.action, "ambiguous");
  assert.equal(h.sends.length, 0);
  assert.equal(h.queue.length, 1, "目标不明确时不应继续听确认");
  assert.ok(h.events.some(function (event) { return event.phase === "target" && event.ok === false; }));
});

test("口述：sendPrompt 抛错时只调用一次，且不重试", async () => {
  const h = harness({
    focus: "a",
    script: ["把登录页改成深色", "确认发送"],
    sendError: new Error("DSH 事件通道未连接"),
  });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.action, "send-failed");
  assert.equal(result.error, "send-failed");
  assert.equal(h.sends.length, 1);
  assert.ok(result.reply.includes("未重试"));
});

test("口述：目标在开始时捕获，中途换关注会话不影响本次发送", async () => {
  const h = harness({
    sessions: [session("a"), session("b")],
    focus: function (call) { return call === 1 ? "a" : "b"; },
    script: ["把登录页改成深色", "确认发送"],
  });
  const result = await h.runner.runFromMicrophone();
  assert.equal(result.ok, true);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].sessionId, "a");
});

test("口述：录音参数透传到 listen", async () => {
  const h = harness({ focus: "a", script: ["把登录页改成深色", "取消"] });
  await h.runner.runFromMicrophone();
  assert.equal(h.listenInputs[0].silence, 1.6);
  assert.equal(h.listenInputs[0].maxSeconds, 30);
  assert.equal(h.listenInputs[0].timeoutMs, 45000);
});
