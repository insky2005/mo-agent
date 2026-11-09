import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSessionPort } from "./commands/daemon.mjs";
import { apkDest } from "./lib/apk.mjs";

/**
 * MO_AGENT_HOME 是 mo 的数据目录开关（mo help 里写着）。
 * daemon / APK 这些曾经写死 os.homedir()，于是隔离环境会碰到真实 ~/.mo-agent。
 */

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-data-home-"));
}

function withHome(value, fn) {
  const previous = process.env.MO_AGENT_HOME;
  if (value === undefined) delete process.env.MO_AGENT_HOME;
  else process.env.MO_AGENT_HOME = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.MO_AGENT_HOME;
    else process.env.MO_AGENT_HOME = previous;
  }
}

test("MO_AGENT_HOME 决定 session.json 的位置", () => {
  const data = tmp();
  fs.writeFileSync(path.join(data, "session.json"), JSON.stringify({ port: 7123 }));
  withHome(data, () => {
    assert.equal(readSessionPort(tmp()), 7123);
  });
});

test("没有 MO_AGENT_HOME 时回落到 <home>/.mo-agent", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, ".mo-agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mo-agent", "session.json"), JSON.stringify({ port: 7333 }));
  withHome(undefined, () => {
    assert.equal(readSessionPort(home), 7333);
  });
});

test("APK 落点跟随 MO_AGENT_HOME", () => {
  const data = tmp();
  withHome(data, () => {
    assert.equal(apkDest(), path.join(data, "app.apk"));
  });
  withHome(undefined, () => {
    assert.equal(apkDest("/tmp/example-home"), "/tmp/example-home/.mo-agent/app.apk");
  });
});

test("隔离 home 下 mo daemon stop 不会碰真实 ~/.mo-agent", () => {
  const data = tmp();
  const project = tmp();
  const result = spawnSync(process.execPath, [MO, "daemon", "stop"], {
    cwd: project,
    env: { ...process.env, MO_AGENT_HOME: data },
    encoding: "utf8",
  });
  assert.doesNotMatch(result.stderr, /EPERM/);
  assert.doesNotMatch(result.stderr, /operation not permitted/);
});
