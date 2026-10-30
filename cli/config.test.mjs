import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-config-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return { root, home, file: path.join(home, "config.json") };
}

function run(ws, args, extraEnv = {}) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: ws.root,
    env: { ...process.env, MO_AGENT_HOME: ws.home, HOME: ws.home, ...extraEnv },
    encoding: "utf8",
  });
}

function runJson(ws, args, extraEnv = {}) {
  const result = run(ws, [...args, "--json"], extraEnv);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

test("list 输出全部键、值与来源（默认）", () => {
  const ws = workspace();
  const result = runJson(ws, ["config", "list"]);
  assert.equal(result.status, 0, result.stderr);
  const keys = result.parsed.config.map((item) => item.key);
  assert.deepEqual(keys, ["host", "port", "authRequired", "pollMs", "logLevel", "recallLimit", "memoryPath"]);
  const port = result.parsed.config.find((item) => item.key === "port");
  assert.deepEqual(port, { key: "port", value: 7788, source: "default", default: 7788 });
  assert.ok(result.parsed.config.every((item) => item.source === "default"));
});

test("set 写文件，get 读到 file 来源", () => {
  const ws = workspace();
  const set = runJson(ws, ["config", "set", "port", "7799"]);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.parsed.value, 7799);
  assert.equal(set.parsed.source, "file");

  const get = runJson(ws, ["config", "get", "port"]);
  assert.equal(get.status, 0, get.stderr);
  assert.deepEqual(get.parsed, { key: "port", value: 7799, source: "file", default: 7788 });

  assert.deepEqual(JSON.parse(fs.readFileSync(ws.file, "utf8")), { port: 7799 });
});

test("布尔值按 true / false 存", () => {
  const ws = workspace();
  assert.equal(runJson(ws, ["config", "set", "authRequired", "false"]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ws.file, "utf8")).authRequired, false);
  assert.equal(runJson(ws, ["config", "set", "authRequired", "true"]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ws.file, "utf8")).authRequired, true);
});

test("非法值 → E_USAGE，退出码 2，并给范围", () => {
  const ws = workspace();
  for (const [key, value] of [["port", "abc"], ["port", "99999"], ["pollMs", "10"], ["logLevel", "verbose"], ["recallLimit", "21"]]) {
    const result = run(ws, ["config", "set", key, value]);
    assert.equal(result.status, 2, key + "=" + value);
    assert.match(result.stderr, /E_USAGE/);
    assert.match(result.stderr, /取值范围/);
  }
  assert.equal(fs.existsSync(ws.file), false, "非法值不该写文件");
});

test("未知键 → E_USAGE，并提示 mo config list", () => {
  const ws = workspace();
  for (const args of [["config", "get", "nope"], ["config", "set", "nope", "1"], ["config", "unset", "nope"]]) {
    const result = run(ws, args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /E_USAGE/);
    assert.match(result.stderr, /mo config list/);
  }
});

test("缺值 → E_USAGE", () => {
  const ws = workspace();
  const result = run(ws, ["config", "set", "port"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_USAGE/);
});

test("unset 删键并回到默认", () => {
  const ws = workspace();
  runJson(ws, ["config", "set", "port", "7799"]);
  const unset = runJson(ws, ["config", "unset", "port"]);
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(unset.parsed.value, 7788);
  assert.equal(unset.parsed.source, "default");
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.file, "utf8")), {});

  const get = runJson(ws, ["config", "get", "port"]);
  assert.equal(get.parsed.value, 7788);
  assert.equal(get.parsed.source, "default");
});

test("环境变量覆盖文件，并在 list 里标出来源", () => {
  const ws = workspace();
  runJson(ws, ["config", "set", "port", "7799"]);
  const listed = runJson(ws, ["config", "list"], { MO_AGENT_PORT: "8123" });
  const port = listed.parsed.config.find((item) => item.key === "port");
  assert.equal(port.value, 8123);
  assert.equal(port.source, "env");

  const get = runJson(ws, ["config", "get", "port"], { MO_AGENT_PORT: "8123" });
  assert.equal(get.parsed.value, 8123);
  assert.equal(get.parsed.source, "env");
});

test("MO_AGENT_CONFIG 改配置文件位置", () => {
  const ws = workspace();
  const custom = path.join(ws.root, "custom-config.json");
  const result = runJson(ws, ["config", "set", "host", "127.0.0.1"], { MO_AGENT_CONFIG: custom });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(custom, "utf8")), { host: "127.0.0.1" });
  assert.equal(fs.existsSync(ws.file), false);
});

test("memoryPath 支持 ~/ 展开", () => {
  const ws = workspace();
  const result = runJson(ws, ["config", "set", "memoryPath", "~/my-memory"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.parsed.value, path.join(ws.home, "my-memory"));
  assert.equal(JSON.parse(fs.readFileSync(ws.file, "utf8")).memoryPath, path.join(ws.home, "my-memory"));

  const get = runJson(ws, ["config", "get", "memoryPath"]);
  assert.equal(get.parsed.value, path.join(ws.home, "my-memory"));
});

test("未知子命令 → E_USAGE", () => {
  const ws = workspace();
  const result = run(ws, ["config", "nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /可用：list/);
});