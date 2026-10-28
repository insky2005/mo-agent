import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildMonitorSnapshot, handleMonitorRoutes, summarizeSessions } from "./monitor-http.mjs";
import { adminCookieValue } from "./admin-auth.mjs";

const LOCAL_TOKEN = "test-local-token";
const WEB_DIR = path.resolve("app/web");

function fakeReq(options = {}) {
  const req = new EventEmitter();
  req.method = options.method || "GET";
  req.headers = Object.assign({ "x-mo-agent-local": LOCAL_TOKEN }, options.headers || {});
  req.socket = { remoteAddress: options.remoteAddress || "127.0.0.1" };
  return req;
}

function fakeRes(options = {}) {
  return Object.assign(new EventEmitter(), {
    statusCode: 0,
    headers: null,
    body: "",
    implicit: {},
    setHeader(name, value) {
      this.implicit[String(name).toLowerCase()] = String(value);
    },
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = Object.assign({}, this.implicit, headers || {});
    },
    write(chunk) {
      this.body += chunk == null ? "" : String(chunk);
      return true;
    },
    end(chunk) {
      if (options.noEnd) throw new Error("SSE should not call end");
      this.body += chunk == null ? "" : String(chunk);
    },
  });
}

function makeHub(sessions, events) {
  const listeners = new Set();
  const buffer = (events || []).slice();
  let seq = buffer.length ? buffer[buffer.length - 1].seq : 0;
  return {
    startedAt: Date.now() - 5000,
    adapters: new Map([["dsh", {}], ["claude-code", {}]]),
    list() { return sessions || []; },
    store: {
      get seq() { return seq; },
      since(after) { return buffer.filter((event) => event.seq > (after || 0)); },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    push(event) {
      seq = event.seq;
      buffer.push(event);
      for (const listener of listeners) listener(event);
    },
    listenerCount() { return listeners.size; },
  };
}

function ctxFor(hub, overrides = {}) {
  return Object.assign({
    hub,
    broker: { list: () => [{ id: "a1", agentLabel: "Claude Code", sessionId: "s1", title: "rm", toolName: "Bash" }] },
    monitor: {
      lastError: null,
      pollMs: 1500,
      startedAt: 1,
      pending: new Map([["q1", { eventId: "q1", kind: "question", sessionId: "s1", question: { questions: [{ question: "继续吗" }] } }]]),
    },
    processes: { list: () => [{ name: "claude" }] },
    runtime: { clientCount: () => 2 },
    webDir: WEB_DIR,
    localToken: LOCAL_TOKEN,
  }, overrides);
}

test("summarizeSessions 统计运行 / 等待 / 异常 / 完成", () => {
  const summary = summarizeSessions([
    { sessionId: "a", status: "working", running: true },
    { sessionId: "b", status: "auth-required" },
    { sessionId: "c", status: "failed" },
    { sessionId: "d", status: "completed" },
    { sessionId: "e", status: "idle" },
    { sessionId: "f", status: "working", parentId: "a" },
  ]);
  assert.equal(summary.total, 6);
  assert.equal(summary.running, 2);
  assert.equal(summary.waiting, 1);
  assert.equal(summary.error, 1);
  assert.equal(summary.completed, 1);
  assert.equal(summary.idle, 1);
  assert.equal(summary.attention, 2);
  assert.equal(summary.branches, 1);
});

test("buildMonitorSnapshot 汇总会话、待办、进程与数据源错误", () => {
  const events = [
    { v: 1, seq: 1, at: 100, type: "source.error", payload: { source: "dsh", message: "连接失败" } },
    { v: 1, seq: 2, at: 200, type: "source.error", payload: { source: "dsh", message: "仍然失败" } },
  ];
  const hub = makeHub([{ sessionId: "s1", title: "登录页", status: "working", running: true, agent: "dsh", updatedAt: 5 }], events);
  const snapshot = buildMonitorSnapshot(ctxFor(hub), 1000);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.seq, 2);
  assert.equal(snapshot.summary.running, 1);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.pending.approvals.length, 1);
  assert.equal(snapshot.pending.questions.length, 1);
  assert.equal(snapshot.processes.length, 1);
  assert.equal(snapshot.clients, 2);
  assert.deepEqual(snapshot.sourceErrors, [{ source: "dsh", message: "仍然失败", at: 200 }]);
  assert.equal(snapshot.monitor.pollMs, 1500);
});

test("buildMonitorSnapshot 带钉钉通道状态", () => {
  const snapshot = buildMonitorSnapshot(ctxFor(makeHub([]), {
    dingtalk: {
      getState: () => ({ configured: true, connected: true, binding: { state: "bound" }, usage: { local: { total: 3 } } }),
    },
  }), 1000);
  assert.equal(snapshot.dingtalk.configured, true);
  assert.equal(snapshot.dingtalk.binding.state, "bound");
  assert.equal(snapshot.dingtalk.usage.local.total, 3);
});

test("handleMonitorRoutes 对非监控路径返回 false", async () => {
  const res = fakeRes();
  const handled = await handleMonitorRoutes(fakeReq(), res, new URL("http://x/api/health"), ctxFor(makeHub([])));
  assert.equal(handled, false);
  assert.equal(res.statusCode, 0);
});

test("监控页脚本包含打开设置中心的桌面桥", () => {
  const js = fs.readFileSync(path.join(WEB_DIR, "monitor.js"), "utf8");
  assert.match(js, /open-settings/);
  assert.match(js, /\/settings\?tab=app/);
});

test("handleMonitorRoutes 非 GET 返回 405", async () => {
  const res = fakeRes();
  const handled = await handleMonitorRoutes(fakeReq({ method: "POST" }), res, new URL("http://x/monitor"), ctxFor(makeHub([])));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 405);
});

test("handleMonitorRoutes 拒绝局域网访问", async () => {
  const res = fakeRes();
  const handled = await handleMonitorRoutes(
    fakeReq({ remoteAddress: "192.168.1.8" }),
    res,
    new URL("http://x/monitor"),
    ctxFor(makeHub([])),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /仅限电脑本机/);
});

test("handleMonitorRoutes 缺少令牌时 401", async () => {
  const res = fakeRes();
  const handled = await handleMonitorRoutes(
    fakeReq({ headers: { "x-mo-agent-local": "" } }),
    res,
    new URL("http://x/monitor"),
    ctxFor(makeHub([])),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /需要本机鉴权/);
});

test("handleMonitorRoutes 返回监控页并下发 Cookie", async () => {
  const res = fakeRes();
  const handled = await handleMonitorRoutes(fakeReq(), res, new URL("http://x/monitor"), ctxFor(makeHub([])));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.body, /mo-agent · 实时监控/);
  assert.match(res.body, /monitor\.js/);
  assert.match(res.body, /id="btnSettings"/);
  assert.match(res.headers["set-cookie"] || "", new RegExp("mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN)));
});

test("handleMonitorRoutes 允许 Cookie 访问 /monitor/state", async () => {
  const hub = makeHub([{ sessionId: "s1", status: "idle" }]);
  const res = fakeRes();
  const handled = await handleMonitorRoutes(
    fakeReq({ headers: { "x-mo-agent-local": "", cookie: "mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN) } }),
    res,
    new URL("http://x/monitor/state"),
    ctxFor(hub),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sources.length, 2);
});

test("handleMonitorRoutes /monitor/events 先补状态事件，再持续推送", async () => {
  const hub = makeHub([], [
    { v: 1, seq: 1, at: 100, type: "session.upsert", payload: { sessionId: "s1" } },
    { v: 1, seq: 2, at: 200, type: "run.completed", payload: { sessionId: "s1" } },
  ]);
  const req = fakeReq();
  const res = fakeRes({ noEnd: true });
  const handled = await handleMonitorRoutes(req, res, new URL("http://x/monitor/events?since=0"), ctxFor(hub));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);
  assert.match(res.body, /"type":"session.upsert"/);
  assert.equal(res.body.includes('"type":"run.completed"'), false, "一次性信号不补发");
  assert.equal(hub.listenerCount(), 1);

  hub.push({ v: 1, seq: 3, at: 300, type: "approval.pending", payload: { id: "a1" } });
  assert.match(res.body, /"type":"approval.pending"/);

  req.emit("close");
  assert.equal(hub.listenerCount(), 0);
});
