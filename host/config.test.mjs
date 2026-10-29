import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.mjs";

function workspace() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mo-host-config-"));
  return { home, file: path.join(home, "config.json") };
}

function write(file, value) {
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", "utf8");
}

function capture(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { value: fn(), stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

test("默认值：没有配置文件时用 DEFAULTS", () => {
  const ws = workspace();
  const cfg = loadConfig([], { home: ws.home, env: {} });
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 7788);
  assert.equal(cfg.authRequired, true);
  assert.equal(cfg.pollMs, 1500);
  assert.equal(cfg.logLevel, "info");
});

test("config.json 覆盖默认值", () => {
  const ws = workspace();
  write(ws.file, { host: "127.0.0.1", port: 7799, authRequired: false, pollMs: 2500, logLevel: "debug" });
  const cfg = loadConfig([], { home: ws.home, env: {} });
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 7799);
  assert.equal(cfg.authRequired, false);
  assert.equal(cfg.pollMs, 2500);
  assert.equal(cfg.logLevel, "debug");
});

test("环境变量覆盖文件", () => {
  const ws = workspace();
  write(ws.file, { host: "127.0.0.1", port: 7799 });
  const cfg = loadConfig([], {
    home: ws.home,
    env: { MO_AGENT_PORT: "8123", MO_AGENT_LOG_LEVEL: "warn", MO_AGENT_NO_AUTH: "1" },
  });
  assert.equal(cfg.port, 8123);
  assert.equal(cfg.logLevel, "warn");
  assert.equal(cfg.authRequired, false);
  assert.equal(cfg.host, "127.0.0.1");
});

test("命令行参数覆盖环境变量与文件", () => {
  const ws = workspace();
  write(ws.file, { port: 7799 });
  const cfg = loadConfig(["node", "host/index.mjs", "--port", "9001", "--host", "127.0.0.2"], {
    home: ws.home,
    env: { MO_AGENT_PORT: "8123" },
  });
  assert.equal(cfg.port, 9001);
  assert.equal(cfg.host, "127.0.0.2");
});

test("MO_AGENT_CONFIG 覆盖配置文件路径", () => {
  const ws = workspace();
  write(ws.file, { port: 7799 });
  const custom = path.join(ws.home, "custom.json");
  write(custom, { port: 6600 });
  const cfg = loadConfig([], { home: ws.home, env: { MO_AGENT_CONFIG: custom } });
  assert.equal(cfg.port, 6600);
});

test("坏 JSON 不崩：警告一行，其余按默认", () => {
  const ws = workspace();
  write(ws.file, "{ not json");
  const { value: cfg, stderr } = capture(() => loadConfig([], { home: ws.home, env: {} }));
  assert.equal(cfg.port, 7788);
  assert.match(stderr, /\[W_CONFIG\]/);
});

test("字段非法不崩：只忽略那个键", () => {
  const ws = workspace();
  write(ws.file, { port: 99999, logLevel: "debug" });
  const { value: cfg, stderr } = capture(() => loadConfig([], { home: ws.home, env: {} }));
  assert.equal(cfg.port, 7788);
  assert.equal(cfg.logLevel, "debug");
  assert.match(stderr, /port 非法/);
});
