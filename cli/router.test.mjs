import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostAliveSync, readHostSession, routerCommand } from "./commands/router.mjs";

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
  assert.deepEqual(readHostSession(home), { port: 7788, token: "t0k", pid: 1234 });
});

test("readHostSession：读端口与令牌；端口缺失视为不可用", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".mo-agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mo-agent", "session.json"), JSON.stringify({ port: 7788, token: "t0k" }));
  assert.deepEqual(readHostSession(home), { port: 7788, token: "t0k", pid: null });

  fs.writeFileSync(path.join(home, ".mo-agent", "session.json"), JSON.stringify({ token: "t0k" }));
  assert.equal(readHostSession(home), null);
});

test("hostAliveSync：session.json 是旧的不代表 host 在跑", () => {
  assert.equal(hostAliveSync(null), false);
  assert.equal(hostAliveSync({ port: 7788 }), false, "没有 pid 就不能算活着");
  assert.equal(hostAliveSync({ port: 7788, pid: 999999 }), false, "pid 不存在的进程不算活着");
  assert.equal(hostAliveSync({ port: 7788, pid: process.pid }), true, "自己的 pid 应该算活着");
});

test("命令全在本地执行：没有 host 也能 status / runtime list", async () => {
  const home = tempHome();
  const isolated = { home, dataDir: home };
  const statusCode = await routerCommand(isolated, { positional: ["status"], options: { json: [] } });
  assert.equal(statusCode, 1, "未运行时退出码 1");
  const listCode = await routerCommand(isolated, { positional: ["runtime"], options: { json: [] } });
  assert.equal(listCode, 0, "runtime list 不该依赖 host");
});

test("start 报的是配置缺失（运行时/凭据），不是 host 没在运行", async () => {
  const home = tempHome();
  await assert.rejects(
    // --window 走非前台路径，避免测试占住终端
    () => routerCommand({ home, dataDir: home }, { positional: ["start"], options: { window: [] } }),
    (error) => ["E_ROUTER_RUNTIME_MISSING", "E_ROUTER_NO_CREDENTIAL"].includes(error.code)
  );
});

test("裸 mo router 等同于 start（不用记两层子命令）", async () => {
  const home = tempHome();
  await assert.rejects(
    () => routerCommand({ home, dataDir: home }, { positional: [], options: { window: [] } }),
    (error) => ["E_ROUTER_RUNTIME_MISSING", "E_ROUTER_NO_CREDENTIAL"].includes(error.code)
  );
});

test("未知子命令给用法", async () => {
  await assert.rejects(
    () => routerCommand({ home: tempHome() }, { positional: ["bogus"], options: {} }),
    (error) => error.code === "E_USAGE" && /mo router start/.test(error.message)
  );
});
