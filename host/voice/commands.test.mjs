import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND, createCommandExecutor, parseCommand } from "./commands.mjs";

function makeVoice(script) {
  const said = [];
  const queue = (script || []).slice();
  return {
    said,
    queue,
    speak: async function (text) { said.push(text); },
    listen: async function () {
      if (!queue.length) return { ok: false, error: "timeout" };
      const next = queue.shift();
      if (typeof next === "string") return { ok: true, text: next, confidence: 1 };
      return next;
    },
  };
}

const SESSIONS = [
  { id: "s1", title: "登录页", status: "working", running: true, pending: [], updatedAt: 3 },
  { id: "s2", title: "支付改造", status: "input-required", running: false, pending: [], updatedAt: 2 },
  { id: "s3", title: "文档", status: "idle", running: false, pending: [], updatedAt: 1 },
];

function makeExecutor(input) {
  const opts = input || {};
  const voice = opts.voice || makeVoice([]);
  const sessions = (opts.sessions || SESSIONS).slice();
  const pending = (opts.pending || []).slice();
  const logs = [];
  const state = { now: typeof opts.now === "number" ? opts.now : 1000000 };
  const hub = {
    list: function () { return sessions; },
    get: function (id) { return sessions.find(function (item) { return item.id === id; }) || null; },
  };
  const broker = { list: function () { return pending; } };
  const executor = createCommandExecutor({
    hub,
    broker,
    speak: voice.speak,
    listen: voice.listen,
    log: { info: function (line) { logs.push(line); }, warn: function (line) { logs.push(line); } },
    now: function () { return state.now; },
    muteMinutes: opts.muteMinutes,
  });
  return { executor, voice, logs, state, sessions, pending };
}

// ---------- 解析 ----------

test("解析：状态查询的常见说法", () => {
  for (const text of ["汇报状态", "现在怎么样", "什么情况", "几个会话", "状态如何"]) {
    assert.equal(parseCommand(text).intent, COMMAND.STATUS, text);
  }
});

test("解析：whisper 输出繁体也能归一", () => {
  assert.equal(parseCommand("匯報狀態").intent, COMMAND.STATUS);
  assert.equal(parseCommand("現在怎麼樣").intent, COMMAND.STATUS);
  assert.equal(parseCommand("幾個會話").intent, COMMAND.STATUS);
  assert.equal(parseCommand("暫停").intent, COMMAND.PAUSE);
  assert.equal(parseCommand("靜音").intent, COMMAND.PAUSE);
  assert.equal(parseCommand("繼續").intent, COMMAND.RESUME);
  assert.equal(parseCommand("恢復").intent, COMMAND.RESUME);
  assert.equal(parseCommand("幫助").intent, COMMAND.HELP);
  assert.deepEqual(parseCommand("切換到登錄頁").sessionHint, { kind: "title", text: "登录页" });
});

test("解析：暂停的常见说法", () => {
  for (const text of ["暂停", "暂停一下", "停一下", "静音", "帮我暂停"]) {
    assert.equal(parseCommand(text).intent, COMMAND.PAUSE, text);
  }
});

test("解析：继续 / 恢复", () => {
  for (const text of ["继续", "恢复", "取消静音", "解除静音", "别静音"]) {
    assert.equal(parseCommand(text).intent, COMMAND.RESUME, text);
  }
});

test("解析：切换的序号（阿拉伯数字 / 中文数字）", () => {
  assert.deepEqual(parseCommand("切到第2个").sessionHint, { kind: "index", index: 2 });
  assert.deepEqual(parseCommand("切换到第二个").sessionHint, { kind: "index", index: 2 });
  assert.deepEqual(parseCommand("切换到第 10 个").sessionHint, { kind: "index", index: 10 });
  assert.deepEqual(parseCommand("切到第2个会话").sessionHint, { kind: "index", index: 2 });
  assert.equal(parseCommand("切到第2个").intent, COMMAND.SWITCH);
});

test("解析：切换的标题片段", () => {
  assert.deepEqual(parseCommand("切换到登录页").sessionHint, { kind: "title", text: "登录页" });
  assert.deepEqual(parseCommand("切到支付改造").sessionHint, { kind: "title", text: "支付改造" });
  assert.deepEqual(parseCommand("切换到登录页的会话").sessionHint, { kind: "title", text: "登录页" });
});

test("解析：切换没有目标时不猜", () => {
  const parsed = parseCommand("切换到");
  assert.equal(parsed.intent, COMMAND.UNKNOWN);
  assert.equal(parsed.sessionHint, null);
});

test("解析：帮助", () => {
  for (const text of ["帮助", "你能做什么", "怎么用", "有哪些命令"]) {
    assert.equal(parseCommand(text).intent, COMMAND.HELP, text);
  }
});

test("解析：未知说法不执行任何动作", () => {
  for (const text of ["今天天气不错", "把代码改一下", "四七二九", ""]) {
    assert.equal(parseCommand(text).intent, COMMAND.UNKNOWN, text);
  }
});

test("解析：同时像暂停又像状态，判为歧义", () => {
  const parsed = parseCommand("暂停一下看看状态");
  assert.equal(parsed.intent, COMMAND.UNKNOWN);
  assert.equal(parsed.reason, "ambiguous");
});

test("解析：「静音了吗」是状态，不是暂停命令", () => {
  assert.equal(parseCommand("静音了吗").intent, COMMAND.STATUS);
  assert.equal(parseCommand("现在是不是静音").intent, COMMAND.STATUS);
});

// ---------- 执行 ----------

test("执行：状态查询报告计数，不改任何状态", async () => {
  const { executor, voice } = makeExecutor({ pending: [{ id: "p1" }] });
  const result = await executor.dispatch("汇报状态");
  assert.equal(result.ok, true);
  assert.equal(result.intent, COMMAND.STATUS);
  assert.match(result.reply, /共 3 个会话/);
  assert.match(result.reply, /1 个运行中/);
  assert.match(result.reply, /1 个等待/);
  assert.match(result.reply, /待授权 1 个/);
  assert.match(result.reply, /未设置关注会话/);
  assert.match(result.reply, /语音未静音/);
  assert.equal(executor.isMuted(), false);
  assert.ok(voice.said.includes(result.reply));
});

test("执行：帮助不产生副作用", async () => {
  const { executor } = makeExecutor();
  const result = await executor.dispatch("你能做什么");
  assert.equal(result.intent, COMMAND.HELP);
  assert.match(result.reply, /汇报状态/);
});

test("执行：暂停需要确认，确认后静音 15 分钟", async () => {
  const voice = makeVoice(["确认"]);
  const { executor, logs } = makeExecutor({ voice });
  const result = await executor.dispatch("暂停");
  assert.equal(result.ok, true);
  assert.equal(result.action, "muted");
  assert.equal(executor.isMuted(), true);
  assert.match(voice.said[0], /要暂停/);
  assert.match(result.reply, /已暂停/);
  assert.ok(logs.some(function (line) { return line.includes("intent=pause") && line.includes("结果=muted 15min"); }));
});

test("执行：暂停被取消时不静音", async () => {
  const voice = makeVoice(["取消"]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.dispatch("暂停");
  assert.equal(result.ok, false);
  assert.equal(result.action, "cancelled");
  assert.equal(executor.isMuted(), false);
  assert.match(result.reply, /已取消/);
});

test("执行：确认低置信度不执行", async () => {
  const voice = makeVoice([{ ok: true, text: "确认", confidence: 0.1 }]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.dispatch("暂停");
  assert.equal(result.ok, false);
  assert.equal(executor.isMuted(), false);
  assert.match(result.reply, /没听清/);
});

test("执行：没听到确认不执行", async () => {
  const voice = makeVoice([]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.dispatch("暂停");
  assert.equal(result.ok, false);
  assert.equal(executor.isMuted(), false);
  assert.match(result.reply, /没有听到确认/);
});

test("执行：继续需要确认，确认后恢复播报", async () => {
  const voice = makeVoice(["确认"]);
  const { executor } = makeExecutor({ voice });
  executor.mute();
  assert.equal(executor.isMuted(), true);
  const result = await executor.dispatch("继续");
  assert.equal(result.ok, true);
  assert.equal(result.action, "unmuted");
  assert.equal(executor.isMuted(), false);
});

test("执行：已静音时暂停只报告剩余时间，不再确认", async () => {
  const voice = makeVoice(["确认"]);
  const { executor } = makeExecutor({ voice });
  executor.mute();
  const result = await executor.dispatch("暂停");
  assert.equal(result.ok, false);
  assert.equal(result.action, "noop");
  assert.match(result.reply, /已经静音/);
  assert.equal(voice.queue.length, 1, "不应消费确认台词");
});

test("执行：静音期间状态查询报告剩余分钟", async () => {
  const { executor, state } = makeExecutor({ voice: makeVoice([]) });
  executor.mute();
  state.now += 5 * 60 * 1000;
  const result = await executor.dispatch("静音了吗");
  assert.equal(result.intent, COMMAND.STATUS);
  assert.match(result.reply, /语音已静音，还剩 10 分钟/);
});

test("执行：按序号切换会话，回读后确认", async () => {
  const voice = makeVoice(["确认"]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.dispatch("切到第2个");
  assert.equal(result.ok, true);
  assert.equal(result.action, "switched");
  assert.equal(executor.targetSessionId(), "s2");
  assert.match(result.reply, /第 2 个会话「支付改造」/);
  assert.match(voice.said[0], /要切换到第 2 个会话「支付改造」，确认吗/);
});

test("执行：按标题片段切换会话", async () => {
  const { executor } = makeExecutor({ voice: makeVoice(["确认"]) });
  const result = await executor.dispatch("切换到支付改造");
  assert.equal(result.ok, true);
  assert.equal(executor.targetSessionId(), "s2");
});

test("执行：状态围绕已关注会话汇报", async () => {
  const voice = makeVoice(["确认", "汇报状态"]);
  const { executor } = makeExecutor({ voice });
  await executor.dispatch("切到第2个");
  const result = await executor.dispatch("汇报状态");
  assert.match(result.reply, /当前关注「支付改造」（等待回答）/);
  assert.match(result.reply, /共 3 个会话/);
});

test("执行：多个标题候选时列出来，不猜", async () => {
  const sessions = [
    { id: "a", title: "登录页改版", status: "working", running: true, updatedAt: 2 },
    { id: "b", title: "登录页旧版", status: "idle", updatedAt: 1 },
  ];
  const voice = makeVoice(["确认"]);
  const { executor } = makeExecutor({ sessions, voice });
  const result = await executor.dispatch("切换到登录页");
  assert.equal(result.ok, false);
  assert.equal(result.action, "ambiguous");
  assert.equal(executor.targetSessionId(), null);
  assert.equal(voice.queue.length, 1, "歧义时不应进入确认");
  assert.match(result.reply, /找到 2 个会话/);
  assert.equal(result.candidates.length, 2);
});

test("执行：找不到标题时给候选，不切换", async () => {
  const { executor } = makeExecutor({ voice: makeVoice(["确认"]) });
  const result = await executor.dispatch("切换到不存在的会话");
  assert.equal(result.ok, false);
  assert.equal(result.action, "not-found");
  assert.equal(executor.targetSessionId(), null);
  assert.match(result.reply, /找不到/);
  assert.match(result.reply, /登录页/);
});

test("执行：序号越界时给候选，不切换", async () => {
  const { executor } = makeExecutor({ voice: makeVoice(["确认"]) });
  const result = await executor.dispatch("切到第9个");
  assert.equal(result.ok, false);
  assert.match(result.reply, /只有 2 个会话/);
  assert.equal(executor.targetSessionId(), null);
});

test("执行：未知命令只提示，不执行", async () => {
  const voice = makeVoice(["确认"]);
  const { executor, logs } = makeExecutor({ voice });
  const result = await executor.dispatch("今天天气不错");
  assert.equal(result.ok, false);
  assert.equal(result.intent, COMMAND.UNKNOWN);
  assert.equal(executor.isMuted(), false);
  assert.equal(voice.queue.length, 1);
  assert.ok(logs.some(function (line) { return line.includes("intent=unknown") && line.includes("结果=unknown"); }));
});

test("执行：歧义句不执行任何动作", async () => {
  const voice = makeVoice(["确认"]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.dispatch("暂停一下看看状态");
  assert.equal(result.intent, COMMAND.UNKNOWN);
  assert.equal(executor.isMuted(), false);
  assert.equal(voice.queue.length, 1);
});

// ---------- 麦克风入口 ----------

test("入口：说一句话走完整条命令链路", async () => {
  const voice = makeVoice(["汇报状态"]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.runFromMicrophone();
  assert.equal(result.ok, true);
  assert.equal(result.intent, COMMAND.STATUS);
  assert.equal(result.heard.text, "汇报状态");
  assert.ok(voice.said[0].includes("请说命令"));
});

test("入口：低置信度命令不执行", async () => {
  const voice = makeVoice([{ ok: true, text: "暂停", confidence: 0.1 }, "确认"]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.equal(result.intent, COMMAND.UNKNOWN);
  assert.equal(executor.isMuted(), false);
  assert.equal(voice.queue.length, 1, "不应消费确认台词");
});

test("入口：没听到命令不报错崩溃", async () => {
  const { executor } = makeExecutor({ voice: makeVoice([]) });
  const result = await executor.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.match(result.reply, /没有听到命令/);
});
