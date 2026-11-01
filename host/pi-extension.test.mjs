import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installPiExtension,
  piAgentDir,
  piExtensionDir,
  piExtensionStatus,
  uninstallPiExtension,
} from "./pi-extension.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quietEnv = {};

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-pi-ext-"));
}

test("Pi 扩展安装：写入两个文件，重复安装不变", () => {
  const home = tempHome();
  const first = installPiExtension({ root, home, env: quietEnv });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  const dir = piExtensionDir({ home, env: quietEnv });
  assert.ok(fs.existsSync(path.join(dir, "mo-agent-control.js")));
  assert.ok(fs.existsSync(path.join(dir, "mo-agent-control-impl.js")));

  const second = installPiExtension({ root, home, env: quietEnv });
  assert.equal(second.changed, false);

  const status = piExtensionStatus({ root, home, env: quietEnv });
  assert.equal(status.installed, true);
  assert.equal(status.outdated, false);
});

test("Pi 扩展安装：旧文件先备份再更新", () => {
  const home = tempHome();
  const dir = piExtensionDir({ home, env: quietEnv });
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "mo-agent-control.js");
  fs.writeFileSync(target, "MO_AGENT_PI_CONTROL old", "utf8");

  const status = piExtensionStatus({ root, home, env: quietEnv });
  assert.equal(status.outdated, false, "另一个文件缺失时不算 outdated");
  assert.equal(status.installed, false);

  const result = installPiExtension({ root, home, env: quietEnv, now: 1700000000000 });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.backups.length, 1);
  assert.ok(fs.existsSync(result.backups[0]));
  assert.match(fs.readFileSync(result.backups[0], "utf8"), /old/);
});

test("Pi 扩展安装：dry-run 不写盘", () => {
  const home = tempHome();
  const result = installPiExtension({ root, home, env: quietEnv, dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(piExtensionDir({ home, env: quietEnv })), false);
});

test("Pi 扩展卸载：只删带标记的文件", () => {
  const home = tempHome();
  installPiExtension({ root, home, env: quietEnv });
  const dir = piExtensionDir({ home, env: quietEnv });
  const keep = path.join(dir, "keep.js");
  fs.writeFileSync(keep, "user file", "utf8");
  fs.writeFileSync(path.join(dir, "mo-agent-control.js"), "user replaced", "utf8");

  const result = uninstallPiExtension({ root, home, env: quietEnv });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(path.join(dir, "mo-agent-control-impl.js")), false);
  assert.equal(fs.existsSync(path.join(dir, "mo-agent-control.js")), true, "不带标记的文件不能删");
  assert.equal(fs.existsSync(keep), true);
});

test("Pi 扩展：PI_CODING_AGENT_DIR 覆盖 agent 目录", () => {
  const home = tempHome();
  const custom = path.join(home, "custom-agent");
  const dir = piAgentDir({ home, env: { PI_CODING_AGENT_DIR: custom } });
  assert.equal(dir, path.resolve(custom));
  assert.equal(piExtensionDir({ home, env: { PI_CODING_AGENT_DIR: custom } }), path.join(custom, "extensions"));
});
