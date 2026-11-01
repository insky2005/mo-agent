import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeModel } from "./probe.mjs";

function fakeBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-probe-"));
  const file = path.join(dir, "fake-pi");
  fs.writeFileSync(file, "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  return file;
}

test("测通成功：退出码 0 且有输出", async () => {
  const result = await probeModel({ bin: fakeBin("echo pong"), timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.text, "pong");
  assert.ok(result.ms >= 0);
});

test("测通失败：非零退出码带上原始错误", async () => {
  const result = await probeModel({ bin: fakeBin("echo 'no api key' 1>&2; exit 1"), timeoutMs: 10000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /no api key/);
});

test("测通失败：可执行文件不存在也不崩", async () => {
  const result = await probeModel({ bin: "/nonexistent/fake-pi", timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("没给运行时直接返回失败", async () => {
  const result = await probeModel({});
  assert.equal(result.ok, false);
});
