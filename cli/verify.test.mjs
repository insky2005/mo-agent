import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runVerify } from "./lib/verify.mjs";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-verify-"));
}

function card(verify) {
  return { meta: { verify }, body: "" };
}

test("全部通过 → ok", () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "out.txt"), "hello world\n");
  const outcome = runVerify({
    card: card([
      { run: "true" },
      { check: "out.txt 存在" },
      { check: "out.txt 包含 hello world" },
    ]),
    root,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.needsHuman, false);
  assert.equal(outcome.results.length, 3);
  assert.ok(outcome.results.every((item) => item.ok));
});

test("run 失败 → 不算通过", () => {
  const root = workspace();
  const outcome = runVerify({ card: card([{ run: "false" }]), root });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.needsHuman, false);
  assert.equal(outcome.results[0].kind, "run");
  assert.equal(outcome.results[0].ok, false);
  assert.match(outcome.results[0].detail, /退出码 1/);
});

test("check 文件不存在 → 失败", () => {
  const root = workspace();
  const outcome = runVerify({ card: card([{ check: "missing.txt 存在" }]), root });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.needsHuman, false);
  assert.equal(outcome.results[0].ok, false);
  assert.match(outcome.results[0].detail, /文件不存在/);
});

test("human 项 → needs_human，不执行也不当失败", () => {
  const root = workspace();
  const outcome = runVerify({ card: card([{ human: "看一眼页面" }]), root });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.needsHuman, true);
  assert.equal(outcome.results[0].kind, "human");
  assert.equal(outcome.results[0].ok, false);
  assert.match(outcome.results[0].detail, /需要人工确认/);
});

test("run 超时 → 失败", () => {
  const root = workspace();
  const outcome = runVerify({ card: card([{ run: "sleep 5" }]), root, timeoutMs: 100 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.needsHuman, false);
  assert.equal(outcome.results[0].ok, false);
  assert.match(outcome.results[0].detail, /超时/);
});

test("verify 为空 → 不执行、不判通过", () => {
  const root = workspace();
  const outcome = runVerify({ card: card([]), root });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.needsHuman, false);
  assert.deepEqual(outcome.results, []);
});

test("无法判定的 check → needs_human 并给原因", () => {
  const root = workspace();
  const outcome = runVerify({ card: card([{ check: "看起来没问题" }]), root });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.needsHuman, true);
  assert.equal(outcome.results[0].kind, "unknown");
  assert.match(outcome.results[0].detail, /无法判定/);
});
