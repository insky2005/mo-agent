import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureNotifyConfig } from "./notify-config.mjs";

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

test("默认配置不存在时安全返回", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-notify-"));
  const created = ensureNotifyConfig({ target: path.join(dir, "notify.json"), defaults: path.join(dir, "missing.json"), log: quiet });
  assert.equal(created, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
