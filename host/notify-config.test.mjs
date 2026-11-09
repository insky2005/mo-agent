import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureNotifyConfig, readQuietHours } from "./notify-config.mjs";

const quiet = { info() {}, warn() {} };

test("首次启动生成默认通知配置", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-notify-"));
  const target = path.join(dir, "notify.json");
  const defaults = path.join(dir, "defaults.json");
  fs.writeFileSync(defaults, JSON.stringify({ channels: [{ type: "hms", appId: "1", appSecret: "x" }] }));
  const created = ensureNotifyConfig({ target, defaults, log: quiet });
  assert.equal(created, true);
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(parsed.channels[0].type, "hms");
  assert.equal(parsed.channels[0].appId, "1");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("配置已存在时不覆盖", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-notify-"));
  const target = path.join(dir, "notify.json");
  const defaults = path.join(dir, "defaults.json");
  fs.writeFileSync(target, JSON.stringify({ channels: [{ type: "wecom", url: "keep" }] }));
  fs.writeFileSync(defaults, JSON.stringify({ channels: [{ type: "hms", appId: "1", appSecret: "x" }] }));
  const created = ensureNotifyConfig({ target, defaults, log: quiet });
  assert.equal(created, false);
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(parsed.channels[0].type, "wecom");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("读得到静音时段", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-notify-"));
  const target = path.join(dir, "notify.json");
  fs.writeFileSync(target, JSON.stringify({ quietHours: { start: "22:30", end: "08:00" } }));
  const quietHours = readQuietHours({ file: target });
  assert.equal(quietHours.start, "22:30");
  assert.equal(quietHours.end, "08:00");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("没有静音配置时返回 null（老配置不会突然变安静）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-notify-"));
  const target = path.join(dir, "notify.json");
  fs.writeFileSync(target, JSON.stringify({ channels: [] }));
  assert.equal(readQuietHours({ file: target }), null);
  assert.equal(readQuietHours({ file: path.join(dir, "missing.json") }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("默认配置不存在时安全返回", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-notify-"));
  const created = ensureNotifyConfig({ target: path.join(dir, "notify.json"), defaults: path.join(dir, "missing.json"), log: quiet });
  assert.equal(created, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
