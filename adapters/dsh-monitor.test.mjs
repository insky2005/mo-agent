import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../core/hub.mjs";
import { AgentMonitor } from "./dsh-monitor.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeMonitor() {
  const hub = new Hub({ log: quiet });
  const notices = [];
  hub.store.subscribe((e) => { if (e.type === "notice") notices.push(e.payload); });
  const dsh = { on() {}, listSessions: async () => ({ items: [] }) };
  const monitor = new AgentMonitor({ hub, dsh, log: quiet });
  return { hub, monitor, notices };
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

test("轮询抓到 RUNNING -> IDLE：发完成通知", () => {
  const { monitor, notices } = makeMonitor();
  monitor.applySession(sessionItem("s1", true, "第一轮"));
  monitor.applySession(sessionItem("s1", false, "第一轮回复"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "completed");
  assert.match(notices[0].body, /第一轮回复/);
});

test("快轮次：实时 status 报结束后，下一次轮询补发完成通知", () => {
  const { monitor, notices } = makeMonitor();
  monitor.applySession(sessionItem("s1", false, "旧回复"));
  monitor.onRemoteEvent({ event: "api-session/status", args: ["s1", true] });
  monitor.onRemoteEvent({ event: "api-session/status", args: ["s1", false] });
  assert.equal(notices.length, 0, "先不通知，等轮询拿到最新回复");
  monitor.applySession(sessionItem("s1", false, "这一轮的新回复"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "completed");
  assert.match(notices[0].body, /新回复/);
});

test("快轮次：仅靠轮次增加也能发完成通知（不依赖实时通道）", () => {
  const { monitor, notices } = makeMonitor();
  const turn = (n) => ({ turn: n, prompt: "p" + n, response: "r" + n });
  monitor.applySession({ sessionId: "s1", running: false, updatedAt: Date.now(), projections: { values: { title: "t", turnOutline: [turn(1)] } } });
  assert.equal(notices.length, 0, "首次建立不通知历史轮次");
  monitor.applySession({ sessionId: "s1", running: false, updatedAt: Date.now() + 1, projections: { values: { title: "t", turnOutline: [turn(1), turn(2)] } } });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "completed");
  assert.match(notices[0].body, /r2/);
});

test("同一轮不会重复通知", () => {
  const { monitor, notices } = makeMonitor();
  monitor.applySession(sessionItem("s1", true, "x"));
  monitor.applySession(sessionItem("s1", false, "x"));
  monitor.applySession(sessionItem("s1", false, "x"));
  assert.equal(notices.length, 1);
});
