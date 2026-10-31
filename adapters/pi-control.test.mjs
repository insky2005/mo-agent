import test from "node:test";
import assert from "node:assert/strict";
import { PiControl, PiControlError } from "./pi-control.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function make(options) {
  return new PiControl(Object.assign({ log: quiet, sessionTtlMs: 60000, pollTimeoutMs: 1000 }, options || {}));
}

test("Pi 控制：注册、在线状态与规范 id", () => {
  const control = make();
  const status = control.register({ sessionId: "abc", sessionFile: "/tmp/a.jsonl", cwd: "/tmp", pid: 42 });
  assert.equal(status.online, true);
  assert.equal(status.sessionId, "pi:abc");
  assert.equal(status.sessionFile, "/tmp/a.jsonl");
  assert.equal(control.isOnline("abc"), true);
  assert.equal(control.isOnline("pi:abc"), true);
  assert.equal(control.isOnline("missing"), false);
});

test("Pi 控制：离线时拒绝下发", () => {
  const control = make();
  assert.throws(() => control.prompt("abc", "hi"), (error) => error instanceof PiControlError && error.code === "E_OFFLINE");
  assert.throws(() => control.cancel("abc"), (error) => error.code === "E_OFFLINE");
});

test("Pi 控制：指令排队，长轮询取走并 ack", async () => {
  const control = make();
  control.register({ sessionId: "abc", cwd: "/tmp" });
  const pending = control.poll("abc", 1000);
  const queued = control.prompt("abc", "继续跑测试", "followUp");
  assert.equal(queued.queued, true);

  const commands = await pending;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "prompt");
  assert.equal(commands[0].text, "继续跑测试");
  assert.equal(commands[0].deliverAs, "followUp");
  assert.ok(commands[0].id);

  assert.deepEqual(control.ack("abc", { id: commands[0].id, ok: true }), { ok: true, id: commands[0].id });
  assert.equal(control.status("abc").pending, 0);
});

test("Pi 控制：先排队后轮询立即返回；abort 不带文本", async () => {
  const control = make();
  control.register({ sessionId: "abc" });
  control.cancel("abc");
  control.prompt("abc", "第二条");
  const commands = await control.poll("abc", 1000);
  assert.deepEqual(commands.map((item) => item.type), ["abort", "prompt"]);
});

test("Pi 控制：abort 丢弃尚未下发的 prompt", async () => {
  const control = make();
  control.register({ sessionId: "abc" });
  control.prompt("abc", "先做这个");
  control.cancel("abc");
  const commands = await control.poll("abc", 1000);
  assert.deepEqual(commands.map((item) => item.type), ["abort"]);
});

test("Pi 控制：轮询超时返回空数组", async () => {
  const control = make();
  control.register({ sessionId: "abc" });
  const commands = await control.poll("abc", 5);
  assert.deepEqual(commands, []);
});

test("Pi 控制：session_shutdown 立即下线；prune 清理过期会话", async () => {
  const control = make({ sessionTtlMs: 10 });
  control.register({ sessionId: "abc" });
  control.event("abc", { event: "session_shutdown" });
  assert.equal(control.isOnline("abc"), false);

  control.register({ sessionId: "def" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  control.prune();
  assert.equal(control.sessions.size, 0);
});
