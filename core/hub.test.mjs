import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "./hub.mjs";
import { EVENT, SESSION_ROLE, normalizeSessionRole } from "./contract.mjs";

function freshHub() {
  return new Hub({ log: { info() {}, warn() {}, error() {} } });
}

test("角色归一：只接受已知值，其余是 unknown", () => {
  assert.equal(normalizeSessionRole("router"), SESSION_ROLE.ROUTER);
  assert.equal(normalizeSessionRole("worker"), SESSION_ROLE.WORKER);
  for (const bad of ["ROUTER", "Router", "main", "", null, undefined, 1]) {
    assert.equal(normalizeSessionRole(bad), SESSION_ROLE.UNKNOWN, String(bad));
  }
});

test("会话默认是 unknown", () => {
  const hub = freshHub();
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "s1", agent: "pi" });
  assert.equal(hub.get("s1").role, SESSION_ROLE.UNKNOWN);
});

test("Router 会话带 role 注入后能被查到", () => {
  const hub = freshHub();
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "mo-router", agent: "pi", role: "router" });
  assert.equal(hub.get("mo-router").role, SESSION_ROLE.ROUTER);
});

test("adapter 重扫同一条会话时不会把 role 洗成 unknown", () => {
  const hub = freshHub();
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "mo-router", agent: "pi", role: "router" });
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "mo-router", agent: "pi", title: "改名了" });
  const session = hub.get("mo-router");
  assert.equal(session.role, SESSION_ROLE.ROUTER, "role 被后续 upsert 覆盖了");
  assert.equal(session.title, "改名了", "其它字段应该照常更新");
});

test("显式改角色是允许的（换角色 / 升级迁移）", () => {
  const hub = freshHub();
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "s1", agent: "pi", role: "router" });
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "s1", agent: "pi", role: "worker" });
  assert.equal(hub.get("s1").role, SESSION_ROLE.WORKER);
});

test("list 支持按 role 过滤，不传参保持原行为", () => {
  const hub = freshHub();
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "mo-router", agent: "pi", role: "router", updatedAt: 1 });
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "w1", agent: "claude-code", role: "worker", updatedAt: 3 });
  hub.emit(EVENT.SESSION_UPSERT, { sessionId: "w2", agent: "pi", updatedAt: 2 });

  assert.equal(hub.list().length, 3);
  assert.deepEqual(hub.list({ role: "router" }).map((item) => item.id), ["mo-router"]);
  assert.deepEqual(hub.list({ role: "worker" }).map((item) => item.id), ["w1"]);
  assert.equal(hub.list({ role: "nonsense" }).length, 0);
  assert.equal(hub.list().map((item) => item.id)[0], "w1", "默认仍按 updatedAt 倒序");
});
