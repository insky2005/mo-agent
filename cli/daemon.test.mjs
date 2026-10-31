import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findHost, readSessionPort, formatLink } from "./commands/daemon.mjs";
import { apkDest } from "./lib/apk.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-daemon-"));
}

test("MO_AGENT_ROOT 指向运行时（有 bin/mo-agent-host）", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "mo-agent-host"), "#!/bin/sh\n", { mode: 0o755 });

  const host = findHost({ env: { MO_AGENT_ROOT: root }, home: tmp(), cwd: tmp() });
  assert.equal(host.kind, "env");
  assert.deepEqual(host.command, [path.join(root, "bin", "mo-agent-host")]);
});

test("源码目录（有 host/index.mjs）用当前解释器起", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "host"), { recursive: true });
  fs.writeFileSync(path.join(root, "host", "index.mjs"), "// noop\n");

  const host = findHost({ env: {}, home: tmp(), cwd: root });
  assert.equal(host.kind, "source");
  assert.equal(host.command[0], process.execPath);
  assert.match(host.command[1], /host[\\/]index\.mjs$/);
});

test("从子目录也能往上找到仓库根", () => {
  const root = tmp();
  const deep = path.join(root, "a", "b");
  fs.mkdirSync(path.join(root, "host"), { recursive: true });
  fs.writeFileSync(path.join(root, "host", "index.mjs"), "// noop\n");
  fs.mkdirSync(deep, { recursive: true });

  const host = findHost({ env: {}, home: tmp(), cwd: deep });
  assert.equal(host.root, root);
});

test("找不到 host 时返回 null", () => {
  assert.equal(findHost({ env: {}, home: tmp(), cwd: tmp() }), null);
});

test("APK 落在 ~/.mo-agent/app.apk", () => {
  assert.equal(apkDest("/tmp/x"), "/tmp/x/.mo-agent/app.apk");
});

test("从 session.json 里认出 host 端口（url 或 port 两种写法）", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, ".mo-agent"), { recursive: true });
  const file = path.join(home, ".mo-agent", "session.json");

  fs.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:7817", token: "x" }));
  assert.equal(readSessionPort(home), 7817);

  fs.writeFileSync(file, JSON.stringify({ port: 9001, token: "x" }));
  assert.equal(readSessionPort(home), 9001);

  fs.writeFileSync(file, "not json");
  assert.equal(readSessionPort(home), null);
});

test("链接令牌的三种呈现：full / masked / hidden", () => {
  assert.equal(formatLink(7788, "/monitor", "abcd1234", "full"), "http://127.0.0.1:7788/monitor?token=abcd1234");
  assert.equal(formatLink(7788, "/monitor", "abcd1234", "masked"), "http://127.0.0.1:7788/monitor?token=abcd…");
  assert.equal(formatLink(7788, "/monitor", "abcd1234", "hidden"), "http://127.0.0.1:7788/monitor?token=<见 ~/.mo-agent/session.json>");
  assert.equal(formatLink(7788, "/monitor", null, "masked"), "http://127.0.0.1:7788/monitor");
  assert.equal(formatLink(7788, "/settings?tab=app", "abcd1234", "full"), "http://127.0.0.1:7788/settings?tab=app&token=abcd1234");
});
