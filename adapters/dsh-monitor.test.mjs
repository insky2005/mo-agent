import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../core/hub.mjs";
import { EVENT } from "../core/contract.mjs";
import { AgentMonitor } from "./dsh-monitor.mjs";
import { Notifier } from "../core/notify.mjs";
import { TASK } from "../core/status.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeMonitor(options) {
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((e) => events.push(e));
  const dsh = { on() {}, listSessions: async () => ({ items: [] }) };
  const monitor = new AgentMonitor({ hub, dsh, log: quiet, profile: options && options.profile });
  return { hub, monitor, events };
}

function completed(events) {
  return events.filter((e) => e.type === EVENT.RUN_COMPLETED);
}

function sessionItem(sessionId, running, response) {
  return {
    sessionId,
    running,
    updatedAt: Date.now(),
    projections: {
      values: {
        title: "t",
        turnOutline: response ? [{ turn: 1, prompt: "p", response }] : [],
      },
    },
  };
}

test("轮询抓到 RUNNING -> 结束：发 run.completed，状态 completed", () => {
  const { monitor, events } = makeMonitor();
  monitor.applySession(sessionItem("s1", true, "第一轮"));
  monitor.applySession(sessionItem("s1", false, "第一轮回复"));
  const done = completed(events);
  assert.equal(done.length, 1);
  assert.match(done[0].payload.text, /第一轮回复/);
  assert.ok(done[0].payload.runId, "run.completed 必须带 runId");
  assert.equal(done[0].payload.agentLabel, "DeepSeek Harness");
  assert.equal(monitor.sessions.get("s1").status, TASK.COMPLETED);
  assert.equal(monitor.sessions.get("s1").agentLabel, "DeepSeek Harness");
});

test("快轮次：实时 status 报结束后，下一次轮询补发完成通知", () => {
  const { monitor, events } = makeMonitor();
  monitor.applySession(sessionItem("s1", false, "旧回复"));
  monitor.onRemoteEvent({ event: "api-session/status", args: ["s1", true] });
  monitor.onRemoteEvent({ event: "api-session/status", args: ["s1", false] });
  assert.equal(completed(events).length, 0, "先不通知，等轮询拿到最新回复");
  monitor.applySession(sessionItem("s1", false, "这一轮的新回复"));
  const done = completed(events);
  assert.equal(done.length, 1);
  assert.match(done[0].payload.text, /新回复/);
  assert.equal(monitor.sessions.get("s1").status, TASK.COMPLETED);
});

test("快轮次：仅靠轮次增加也能发完成通知（不依赖实时通道）", () => {
  const { monitor, events } = makeMonitor();
  const turn = (n) => ({ turn: n, prompt: "p" + n, response: "r" + n });
  monitor.applySession({ sessionId: "s1", running: false, updatedAt: Date.now(), projections: { values: { title: "t", turnOutline: [turn(1)] } } });
  assert.equal(completed(events).length, 0, "首次建立不通知历史轮次");
  monitor.applySession({ sessionId: "s1", running: false, updatedAt: Date.now() + 1, projections: { values: { title: "t", turnOutline: [turn(1), turn(2)] } } });
  const done = completed(events);
  assert.equal(done.length, 1);
  assert.match(done[0].payload.text, /r2/);
  assert.equal(monitor.sessions.get("s1").status, TASK.COMPLETED);
});

test("同一轮不会重复通知", () => {
  const { monitor, events } = makeMonitor();
  monitor.applySession(sessionItem("s1", true, "x"));
  monitor.applySession(sessionItem("s1", false, "x"));
  monitor.applySession(sessionItem("s1", false, "x"));
  assert.equal(completed(events).length, 1);
  assert.equal(monitor.sessions.get("s1").status, TASK.COMPLETED, "completed 不能被后续轮询改回 idle");
});

test("重启后未运行但有上一轮回答：状态是 completed 而不是 idle", () => {
  const { monitor } = makeMonitor();
  monitor.applySession(sessionItem("s1", false, "上一轮回答"));
  assert.equal(monitor.sessions.get("s1").status, TASK.COMPLETED);
});

test("从没跑过：保持 idle", () => {
  const { monitor } = makeMonitor();
  monitor.applySession(sessionItem("s1", false, ""));
  assert.equal(monitor.sessions.get("s1").status, "idle");
});

test("api-session/error 发 run.failed，状态 failed", () => {
  const { monitor, events } = makeMonitor();
  monitor.applySession(sessionItem("s1", true, "x"));
  monitor.onRemoteEvent({ event: "api-session/error", args: ["s1", "boom"] });
  const failed = events.filter((e) => e.type === EVENT.RUN_FAILED);
  assert.equal(failed.length, 1);
  assert.match(failed[0].payload.text, /boom/);
  assert.equal(monitor.sessions.get("s1").status, TASK.FAILED);
});

test("DSH 完成走 run.completed -> 一条「任务完成」通知", () => {
  const { hub, monitor, events } = makeMonitor();
  const notifies = [];
  hub.store.subscribe((e) => { if (e.type === EVENT.NOTIFY) notifies.push(e.payload); });
  const notifier = new Notifier({ hub, log: quiet });
  notifier.start();
  monitor.applySession(sessionItem("s1", true, "第一轮"));
  monitor.applySession(sessionItem("s1", false, "第一轮回复"));
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].kind, "completed");
  assert.equal(notifies[0].title, "任务完成");
  assert.ok(notifies[0].runId);
  assert.match(notifies[0].body, /第一轮回复/);
  assert.equal(events.filter((e) => e.type === EVENT.NOTICE).length, 0, "完成不应再发 notice");
});

test("等待授权期间结束：待办处理后再补完成信号", () => {
  const { monitor, events } = makeMonitor();
  monitor.applySession(sessionItem("s1", true, "x"));
  monitor.addPending({ eventId: "e1", kind: "approval", sessionId: "s1", question: { toolName: "Bash" } });
  monitor.applySession(sessionItem("s1", false, "处理完了"));
  assert.equal(completed(events).length, 0, "待办未处理前不发完成信号");
  assert.equal(monitor.sessions.get("s1").status, TASK.AUTH_REQUIRED);
  monitor.resolvePending("e1", "answered");
  assert.equal(completed(events).length, 1);
  assert.equal(monitor.sessions.get("s1").status, TASK.COMPLETED);
});
test("完成后的后续轮询不会清掉 lastRun", () => {
  const { hub, monitor } = makeMonitor();
  monitor.applySession(sessionItem("s1", true, "x"));
  monitor.applySession(sessionItem("s1", false, "done"));
  const lastRun = hub.get("s1").lastRun;
  assert.ok(lastRun && lastRun.runId);
  monitor.applySession(sessionItem("s1", false, "done"));
  assert.equal(hub.get("s1").lastRun.runId, lastRun.runId);
});
test("runEnd: none 只更新状态，不发 run.completed", () => {
  const { monitor, events } = makeMonitor({ profile: { capabilities: { runEnd: "none" } } });
  monitor.applySession(sessionItem("s1", true, "x"));
  monitor.applySession(sessionItem("s1", false, "done"));
  assert.equal(completed(events).length, 0);
  assert.equal(monitor.sessions.get("s1").status, TASK.COMPLETED);
});
test("完成时用 session/page 补全被截断的回复", async () => {
  const { monitor, events } = makeMonitor();
  const full = "完整回复第一行\n完整回复第二行";
  const pages = [];
  monitor.dsh.pageSession = async (sessionId, throughSeq) => {
    pages.push({ sessionId, throughSeq });
    return {
      records: [
        { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: full }] } } } },
      ],
    };
  };

  const item = (running, response, asOfSeq) => {
    const value = sessionItem("s1", running, response);
    value.projections.asOfSeq = asOfSeq;
    return value;
  };

  monitor.applySession(item(true, "开始", 10));
  monitor.applySession(item(false, "预览…", 11));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const done = completed(events);
  assert.equal(done.length, 1);
  assert.equal(done[0].payload.text, full);
  assert.equal(monitor.sessions.get("s1").lastResponse, full);
  assert.deepEqual(pages, [{ sessionId: "s1", throughSeq: 11 }]);
});
test("首次扫描的已完成会话：补全详情但不补发完成通知", async () => {
  const { monitor, events } = makeMonitor();
  const full = "历史会话的完整回复\n第二行";
  monitor.dsh.pageSession = async () => ({
    records: [{ event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: full }] } } } }],
  });
  const item = sessionItem("s1", false, "预览…");
  item.projections.asOfSeq = 20;
  monitor.applySession(item);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completed(events).length, 0);
  assert.equal(monitor.sessions.get("s1").lastResponse, full);
  assert.ok(events.some((event) => event.type === EVENT.SESSION_UPSERT && event.payload.lastResponse === full));
});
test("history 按轮次返回完整历史", async () => {
  const { monitor } = makeMonitor();
  monitor.dsh.pageSession = async () => ({
    records: [
      { event: { type: "user/message", data: { turn: 1, content: [{ type: "text", text: "第一问" }] } } },
      { event: { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "reasoning", text: "思考" }, { type: "text", text: "第一答" }] } } } },
      { event: { type: "user/message", data: { turn: 2, content: [{ type: "text", text: "第二问" }] } } },
      { event: { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "第二答" }] } } } },
    ],
  });
  const item = sessionItem("s1", false, "预览…");
  item.projections.asOfSeq = 20;
  monitor.applySession(item);
  const history = await monitor.history("s1", { limit: 20 });
  assert.deepEqual(history.turns, [
    { turn: 1, prompt: "第一问", response: "第一答" },
    { turn: 2, prompt: "第二问", response: "第二答" },
  ]);
  assert.equal(history.truncated, false);
});
test("history 用 turnOutline 补回 session/page 缺失的轮次", async () => {
  const { monitor } = makeMonitor();
  monitor.dsh.pageSession = async () => ({
    records: [
      { event: { type: "user/message", data: { turn: 1, content: [{ type: "text", text: "一问" }] } } },
      { event: { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "一答" }] } } } },
      { event: { type: "user/message", data: { turn: 3, content: [{ type: "text", text: "三问" }] } } },
      { event: { type: "assistant/message", data: { turn: 3, message: { content: [{ type: "text", text: "三答" }] } } } },
    ],
  });
  monitor.applySession({
    sessionId: "s1",
    running: false,
    updatedAt: Date.now(),
    projections: {
      asOfSeq: 30,
      values: {
        title: "t",
        turnOutline: [
          { turn: 1, prompt: "一", response: "答一" },
          { turn: 2, prompt: "二", response: "答二" },
          { turn: 3, prompt: "三", response: "答三" },
        ],
      },
    },
  });
  const history = await monitor.history("s1", { limit: 50 });
  assert.deepEqual(history.turns.map((item) => item.turn), [1, 2, 3]);
  assert.equal(history.turns[1].prompt, "二");
  assert.equal(history.turns[1].response, "答二");
});
