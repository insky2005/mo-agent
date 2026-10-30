import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideHms } from "./desktop-hms.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCANNER = path.join(HERE, "check-artifacts.mjs");

// ---- 是否打包 HMS 默认配置 ----

test("本地有配置 → 打包", () => {
  const decision = decideHms({ env: {}, exists: true });
  assert.equal(decision.include, true);
});

test("本地没有配置 → 跳过，构建继续", () => {
  const decision = decideHms({ env: {}, exists: false });
  assert.equal(decision.include, false);
  assert.match(decision.reason, /不存在/);
});

test("CI 里有配置也不打包", () => {
  const decision = decideHms({ env: { CI: "true" }, exists: true });
  assert.equal(decision.include, false);
  assert.match(decision.reason, /CI/);
});

test("CI=false 不算 CI", () => {
  assert.equal(decideHms({ env: { CI: "false" }, exists: true }).include, true);
});

test("显式 0 → 不打包", () => {
  assert.equal(decideHms({ env: { MO_AGENT_DESKTOP_HMS: "0" }, exists: true }).include, false);
});

test("显式 1 且有文件 → 打包", () => {
  assert.equal(decideHms({ env: { MO_AGENT_DESKTOP_HMS: "1" }, exists: true }).include, true);
});

test("显式 1 但没文件 → 报 missing，由构建脚本失败", () => {
  const decision = decideHms({ env: { MO_AGENT_DESKTOP_HMS: "1" }, exists: false });
  assert.equal(decision.include, false);
  assert.equal(decision.missing, true);
});

// ---- 产物密钥扫描 ----

function makeSecret(hex) {
  return JSON.stringify({ channels: [{ type: "hms", appSecret: hex }] });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-artifacts-"));
}

function runScanner(args) {
  return spawnSync(process.execPath, [SCANNER, ...args], { encoding: "utf8" });
}

test("目录里带真密钥 → --enforce 失败", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "notify-defaults.json"), makeSecret("a".repeat(64)));
  const result = runScanner(["--enforce", dir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hms-app-secret/);
});

test("干净产物 → --enforce 通过", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "notify-defaults.json"), JSON.stringify({ channels: [] }));
  const result = runScanner(["--enforce", dir]);
  assert.equal(result.status, 0);
});

test("tar.gz 里的密钥也能扫出来", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "notify-defaults.json"), makeSecret("b".repeat(64)));
  const archive = path.join(dir, "runtime.tar.gz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", dir, "notify-defaults.json"]);
  assert.equal(tar.status, 0);
  const result = runScanner(["--enforce", archive]);
  assert.equal(result.status, 1);
});

test("嵌套归档（app.tar.zst → runtime.tar.gz）也能扫到", () => {
  const dir = tmpdir();
  const inner = tmpdir();
  fs.writeFileSync(path.join(inner, "notify-defaults.json"), makeSecret("d".repeat(64)));
  const innerArchive = path.join(dir, "runtime.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", innerArchive, "-C", inner, "notify-defaults.json"]).status, 0);
  const outerArchive = path.join(dir, "app.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", outerArchive, "-C", dir, "runtime.tar.gz"]).status, 0);
  const result = runScanner(["--enforce", outerArchive]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime\.tar\.gz → notify-defaults\.json/);
});

test("不带 --enforce 只警告，不阻断本地构建", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "notify-defaults.json"), makeSecret("c".repeat(64)));
  const result = runScanner([dir]);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /仅限本机自用/);
});
