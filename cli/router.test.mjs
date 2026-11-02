import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHostSession, routerCommand } from "./commands/router.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-router-cli-"));
}

test("readHostSession：没有 session.json 时返回 null", () => {
  assert.equal(readHostSession(tempHome()), null);
});

test("readHostSession：只有 url 也要认（真实 session.json 就是这种）", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".mo-agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".mo-agent", "session.json"),
    JSON.stringify({ url: "http://127.0.0.1:7788", token: "t0k", pid: 1234 })
  );
  assert.deepEqual(readHostSession(home), { port: 7788, token: "t0k" });
});

test("readHostSession：读端口与令牌；端口缺失视为不可用", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".mo-agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mo-agent", "session.json"), JSON.stringify({ port: 7788, token: "t0k" }));
  assert.deepEqual(readHostSession(home), { port: 7788, token: "t0k" });

  fs.writeFileSync(path.join(home, ".mo-agent", "session.json"), JSON.stringify({ token: "t0k" }));
  assert.equal(readHostSession(home), null);
});

test("host 没起来、且关掉本地兜底时给 E_DAEMON_DOWN，而不是未处理异常", async () => {
  const home = tempHome();
  const safe = { home, autoStart: false, disableLocalFallback: true };
  await assert.rejects(() => routerCommand(safe, { positional: ["status"], options: {} }), (error) => error.code === "E_DAEMON_DOWN");
  await assert.rejects(() => routerCommand(safe, { positional: ["start"], options: {} }), (error) => error.code === "E_DAEMON_DOWN");
  await assert.rejects(() => routerCommand(safe, { positional: ["runtime"], options: {} }), (error) => error.code === "E_DAEMON_DOWN");
});

test("host 不在时 status 退回本地实现，不再报 E_DAEMON_DOWN", async () => {
  const home = tempHome();
  // dataDir 指到临时目录：否则读的是本机真实状态，测试会随机器漂
  const code = await routerCommand({ home, dataDir: home, autoStart: false }, { positional: ["status"], options: { json: [] } });
  assert.equal(code, 1, "未运行时退出码 1");
});

test("host 不在时 start 用本地实现：报的是配置缺失，不是 E_DAEMON_DOWN", async () => {
  const home = tempHome();
  await assert.rejects(
    () => routerCommand({ home, dataDir: home, autoStart: false }, { positional: ["start"], options: {} }),
    // 环境相关：没装运行时 → RUNTIME_MISSING；装了但这份 dataDir 没凭据 → NO_CREDENTIAL。
    // 关键是它不再是"host 没在运行"。
    (error) => ["E_ROUTER_RUNTIME_MISSING", "E_ROUTER_NO_CREDENTIAL"].includes(error.code)
  );
});

test("裸 mo router 等同于 start（不用记两层子命令）", async () => {
  const safe = { home: tempHome(), autoStart: false, disableLocalFallback: true };
  await assert.rejects(
    () => routerCommand(safe, { positional: [], options: {} }),
    (error) => error.code === "E_DAEMON_DOWN"
  );
});

test("未知子命令给用法", async () => {
  await assert.rejects(
    () => routerCommand({ home: tempHome() }, { positional: ["bogus"], options: {} }),
    (error) => error.code === "E_USAGE" && /mo router start/.test(error.message)
  );
});
