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

test("readHostSession：读端口与令牌；端口缺失视为不可用", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".mo-agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mo-agent", "session.json"), JSON.stringify({ port: 7788, token: "t0k" }));
  assert.deepEqual(readHostSession(home), { port: 7788, token: "t0k" });

  fs.writeFileSync(path.join(home, ".mo-agent", "session.json"), JSON.stringify({ token: "t0k" }));
  assert.equal(readHostSession(home), null);
});

test("host 没起来时命令给 E_DAEMON_DOWN，而不是未处理异常", async () => {
  const home = tempHome();
  await assert.rejects(() => routerCommand({ home }, { positional: ["status"], options: {} }), (error) => error.code === "E_DAEMON_DOWN");
  await assert.rejects(() => routerCommand({ home }, { positional: ["start"], options: {} }), (error) => error.code === "E_DAEMON_DOWN");
});

test("未知子命令给用法", async () => {
  await assert.rejects(
    () => routerCommand({ home: tempHome() }, { positional: ["bogus"], options: {} }),
    (error) => error.code === "E_USAGE" && /mo router start/.test(error.message)
  );
});
