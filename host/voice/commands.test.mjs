import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND, createCommandExecutor, parseCommand } from "./commands.mjs";

function makeVoice(script) {
  const said = [];
  const inputs = [];
  const queue = (script || []).slice();
  return {
    said,
    inputs,
    queue,
    speak: async function (text) { said.push(text); },
    listen: async function (input) {
      inputs.push(input || {});
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
    prepare: opts.prepare || async function () { return { ok: true, simulated: true }; },
    listenDelayMs: 0,
    log: {
      info: function (line) { logs.push(line); },
      warn: function (line) { logs.push(line); },
      debug: function (line) { logs.push(line); },
    },
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
  assert.deepEqual(parseCommand("切换第一个会话").sessionHint, { kind: "index", index: 1 });
  assert.deepEqual(parseCommand("切第二个").sessionHint, { kind: "index", index: 2 });
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

test("日志：记录监听、解析、确认与执行细节", async () => {
  const voice = makeVoice(["暂停", "确认"]);
  const { executor, logs } = makeExecutor({ voice });
  await executor.runFromMicrophone();
  const text = logs.join("\n");
  assert.match(text, /语音命令: 开始监听 超时=15000ms 最低置信度=0\.35/);
  assert.match(text, /语音命令: 监听完成 .*文本=「暂停」 置信度=1\.00/);
  assert.match(text, /语音命令: 解析 intent=pause 归一=「暂停」/);
  assert.match(text, /语音命令: 需要确认 intent=pause 回读=「要暂停/);
  assert.match(text, /语音命令: 确认输入 文本=「确认」 置信度=1\.00 判定=confirm/);
  assert.match(text, /语音命令: 已执行 action=muted/);
  assert.match(text, /语音命令: 文本=「暂停」 intent=pause 结果=muted 15min 置信度=1\.00 归一=「暂停」/);
});

test("日志：歧义记录归一文本与原因", async () => {
  const { executor, logs } = makeExecutor({ voice: makeVoice(["确认"]) });
  await executor.dispatch("暂停一下看看状态");
  const text = logs.join("\n");
  assert.match(text, /归一=「暂停一下看看状态」/);
  assert.match(text, /结果=unknown 置信度=- 归一=「暂停一下看看状态」 原因=ambiguous/);
});

test("日志：繁体输入记录归一后的文本", async () => {
  const { executor, logs } = makeExecutor({ voice: makeVoice([]) });
  await executor.dispatch("匯報狀態");
  assert.match(logs.join("\n"), /文本=「匯報狀態」 intent=status 结果=reported .*归一=「汇报状态」/);
});

test("入口：命令监听带提示词，并先预热 helper", async () => {
  const voice = makeVoice(["汇报状态"]);
  let prepared = 0;
  const { executor, logs } = makeExecutor({
    voice,
    prepare: async function () {
      prepared += 1;
      return {
        ok: true,
        inputDevice: "HUAWEI FreeBuds SE 3",
        micAuthorization: "AVAuthorizationStatus(rawValue: 3)",
      };
    },
  });
  const result = await executor.runFromMicrophone();
  assert.equal(result.ok, true);
  assert.equal(prepared, 1);
  assert.ok(voice.inputs[0].prompt.includes("汇报状态"));
  assert.ok(voice.inputs[0].prompt.includes("会话"));
  assert.ok(!voice.inputs[0].prompt.includes("确认"), "命令提示词不应包含确认词");
  const text = logs.join("\n");
  assert.match(text, /预热 完成/);
  assert.match(text, /设备=HUAWEI FreeBuds SE 3/);
  assert.match(text, /麦克风=已授权/);
});

test("入口：第一次超时会自动再听一次", async () => {
  const voice = makeVoice([{ ok: false, error: "timeout" }, "汇报状态"]);
  const { executor, logs } = makeExecutor({ voice });
  const result = await executor.runFromMicrophone();
  assert.equal(result.ok, true);
  assert.equal(result.intent, COMMAND.STATUS);
  assert.equal(voice.queue.length, 0);
  assert.ok(voice.said.includes("没有听到，请等提示音再说一次。"));
  const text = logs.join("\n");
  assert.match(text, /监听失败 第1次 错误=timeout/);
  assert.match(text, /监听完成 第2次/);
});

test("入口：连续两次超时才失败", async () => {
  const voice = makeVoice([{ ok: false, error: "timeout" }, { ok: false, error: "timeout" }]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.runFromMicrophone();
  assert.equal(result.ok, false);
  assert.match(result.reply, /没有听到命令/);
  assert.equal(voice.inputs.length, 2);
});

test("执行：确认第一次超时会自动再听一次", async () => {
  const voice = makeVoice([{ ok: false, error: "timeout" }, "确认"]);
  const { executor, logs } = makeExecutor({ voice });
  const result = await executor.dispatch("暂停");
  assert.equal(result.ok, true);
  assert.equal(executor.isMuted(), true);
  assert.equal(voice.queue.length, 0);
  assert.ok(voice.said.includes("没有听到确认，请等提示音再说一次确认。"));
  assert.match(logs.join("\n"), /确认尝试 第2次/);
});

test("入口：mic-silent 也会自动重试", async () => {
  const voice = makeVoice([
    { ok: false, error: "mic-silent", startupMs: 3000, buffers: 0, peak: 0 },
    "汇报状态",
  ]);
  const { executor, logs } = makeExecutor({ voice });
  const result = await executor.runFromMicrophone();
  assert.equal(result.ok, true);
  assert.equal(result.intent, COMMAND.STATUS);
  assert.match(logs.join("\n"), /监听失败 第1次 错误=mic-silent .*启动=3000ms 缓冲=0 峰值=0\.0000/);
});

test("日志：录音诊断写入监听完成日志", async () => {
  const voice = makeVoice([{
    ok: true,
    text: "汇报状态",
    confidence: 0.9,
    record: {
      startupMs: 420,
      buffers: 12,
      peak: 0.03,
      sampleRate: 16000,
      routeChanged: false,
      inputDevice: "HUAWEI FreeBuds SE 3",
    },
  }]);
  const { executor, logs } = makeExecutor({ voice });
  await executor.runFromMicrophone();
  const text = logs.join("\n");
  assert.match(text, /监听完成 第1次 .*启动=420ms 缓冲=12 峰值=0\.0300 采样率=16000/);
  assert.match(text, /设备=HUAWEI FreeBuds SE 3/);
});

// ---------- 麦克风入口 ----------

test("入口：说一句话走完整条命令链路", async () => {
  const voice = makeVoice(["汇报状态"]);
  const { executor } = makeExecutor({ voice });
  const result = await executor.runFromMicrophone();
  assert.equal(result.ok, true);
  assert.equal(result.intent, COMMAND.STATUS);
  assert.equal(result.heard.text, "汇报状态");
  assert.ok(voice.said[0].includes("请等提示音"));
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
