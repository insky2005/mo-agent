import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleLogRoutes, readTail, stripAnsi } from "./logs-http.mjs";
import { adminCookieValue } from "./admin-auth.mjs";

const LOCAL_TOKEN = "test-local-token";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-logs-"));
}

function writeLog(lines) {
  const dir = tmpDir();
  const file = path.join(dir, "host.log");
  fs.writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""));
  return { dir, file };
}

function fakeReq(options = {}) {
  return {
    method: options.method || "GET",
    headers: Object.assign({ "x-mo-agent-local": LOCAL_TOKEN }, options.headers || {}),
    socket: { remoteAddress: options.remoteAddress || "127.0.0.1" },
  };
}

function fakeRes() {
  const res = {
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
    end(chunk) {
      this.body += chunk == null ? "" : String(chunk);
    },
  };
  return res;
}

function ctxFor(file, overrides = {}) {
  return Object.assign({ logFile: file, localToken: LOCAL_TOKEN }, overrides);
}

test("stripAnsi 剥掉 CSI 色码", () => {
  assert.equal(stripAnsi("\u001b[47m\u001b[30mhello\u001b[0m"), "hello");
  assert.equal(stripAnsi("plain"), "plain");
});

test("readTail 返回最后 N 行", () => {
  const { dir, file } = writeLog(["a", "b", "c", "d"]);
  const tail = readTail(file, 2);
  assert.deepEqual(tail.lines, ["c", "d"]);
  assert.equal(tail.size, fs.statSync(file).size);
  assert.ok(tail.updatedAt);
  assert.equal(tail.error, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readTail 剥掉日志里的 ANSI 色码", () => {
  const { dir, file } = writeLog(["\u001b[47mQR\u001b[0m", "\u001b[32mOK\u001b[0m"]);
  const tail = readTail(file, 10);
  assert.deepEqual(tail.lines, ["QR", "OK"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readTail 文件不存在时返回 error 而非抛错", () => {
  const tail = readTail(path.join(tmpDir(), "missing.log"), 10);
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.size, 0);
  assert.ok(tail.error);
});

test("readTail 大文件只取尾部且不保留半行", () => {
  const dir = tmpDir();
  const file = path.join(dir, "big.log");
  const line = "x".repeat(1024);
  fs.writeFileSync(file, (line + "\n").repeat(300) + "LAST\n");
  const tail = readTail(file, 4);
  assert.equal(tail.lines.length, 4);
  assert.equal(tail.lines[tail.lines.length - 1], "LAST");
  assert.ok(tail.lines.every((l) => l === "LAST" || l.length === 1024));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("handleLogRoutes 对其它路径返回 false", async () => {
  const res = fakeRes();
  const handled = await handleLogRoutes(fakeReq(), res, new URL("http://x/api/health"), ctxFor("/tmp/x"));
  assert.equal(handled, false);
  assert.equal(res.statusCode, 0);
});

test("handleLogRoutes 非 GET 返回 405", async () => {
  const res = fakeRes();
  const handled = await handleLogRoutes(fakeReq({ method: "POST" }), res, new URL("http://x/logs"), ctxFor("/tmp/x"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 405);
});

test("handleLogRoutes 拒绝非回环地址（局域网读不到日志）", async () => {
  for (const address of ["192.168.1.5", "10.0.0.2", "::ffff:192.168.1.5"]) {
    const res = fakeRes();
    const handled = await handleLogRoutes(fakeReq({ remoteAddress: address }), res, new URL("http://x/logs"), ctxFor("/tmp/x"));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 403, address + " 应被拒绝");
    assert.match(res.body, /仅本机/);
  }
});

test("handleLogRoutes 回环地址没有本机令牌也拒绝", async () => {
  const res = fakeRes();
  const handled = await handleLogRoutes(fakeReq({ headers: { "x-mo-agent-local": "" } }), res, new URL("http://x/logs"), ctxFor("/tmp/x"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /需要本机鉴权/);
});

test("handleLogRoutes 允许带本机令牌的 query 并下发 Cookie", async () => {
  const lines = Array.from({ length: 25 }, (_, i) => "l" + i);
  const { dir, file } = writeLog(lines);
  const res = fakeRes();
  const handled = await handleLogRoutes(
    fakeReq({ headers: { "x-mo-agent-local": "" } }),
    res,
    new URL("http://x/logs/data?lines=5&token=" + LOCAL_TOKEN),
    ctxFor(file),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.lines.length, 20);
  assert.equal(data.lines[0], "l5");
  assert.equal(data.lines[19], "l24");
  assert.equal(data.path, file);
  assert.equal(data.ok, true);
  assert.match(res.headers["set-cookie"] || "", new RegExp("mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("handleLogRoutes 允许带 Cookie 访问 /logs/data（lines 最小按 20 行）", async () => {
  const lines = Array.from({ length: 25 }, (_, i) => "l" + i);
  const { dir, file } = writeLog(lines);
  const res = fakeRes();
  const handled = await handleLogRoutes(
    fakeReq({ headers: { "x-mo-agent-local": "", cookie: "mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN) } }),
    res,
    new URL("http://x/logs/data?lines=5"),
    ctxFor(file),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.lines.length, 20);
  assert.equal(data.lines[0], "l5");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("handleLogRoutes /logs 返回 HTML 页面", async () => {
  const res = fakeRes();
  const handled = await handleLogRoutes(fakeReq(), res, new URL("http://x/logs"), ctxFor("/tmp/some/host.log"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.body, /mo-agent · 日志/);
});
