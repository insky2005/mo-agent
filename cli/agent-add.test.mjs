import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agentadd-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, project, home };
}

function run(ws, args) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: ws.project,
    env: { ...process.env, MO_AGENT_HOME: ws.home },
    encoding: "utf8",
  });
}

function runJson(ws, args) {
  const result = run(ws, [...args, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

test("describe --json 给出工具、禁止项与规则", () => {
  const ws = workspace();
  const result = runJson(ws, ["agent", "describe"]);
  assert.equal(result.status, 0, result.stderr);
  const names = result.parsed.tools.map((tool) => tool.name);
  assert.ok(names.includes("task_create"));
  assert.ok(names.includes("task_confirm"));
  assert.ok(!names.includes("task_approve"));
  assert.ok(result.parsed.forbidden.some((item) => item.action === "task_approve"));
  assert.ok(result.parsed.rules.length >= 5);
  assert.equal(result.parsed.name, "mo");
});

test("describe --format prompt 输出可粘贴文本", () => {
  const ws = workspace();
  const result = run(ws, ["agent", "describe", "--format", "prompt"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# mo 任务派发契约/);
  assert.match(result.stdout, /mo task approve/);
});

test("describe 不写死具体 Agent 名字", () => {
  const ws = workspace();
  const result = run(ws, ["agent", "describe", "--format", "prompt"]);
  assert.doesNotMatch(result.stdout, /claude|codex|qoder|workbuddy/i);
});

test("add --mcp 新建配置并写对启动命令", () => {
  const ws = workspace();
  const file = path.join(ws.project, "mcp.json");
  const result = runJson(ws, ["agent", "add", "--mcp", "mcp.json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.parsed.changed, true);

  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(config.mcpServers.mo);
  assert.ok(config.mcpServers.mo.args.includes("mcp"));
  assert.ok(fs.existsSync(config.mcpServers.mo.args[0]));
});

test("add --mcp 合并已有服务并保留原内容", () => {
  const ws = workspace();
  const file = path.join(ws.project, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, theme: "dark" }, null, 2));

  const result = runJson(ws, ["agent", "add", "--mcp", "mcp.json"]);
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.theme, "dark");
  assert.ok(config.mcpServers.other);
  assert.ok(config.mcpServers.mo);
  assert.match(result.parsed.backup, /\.bak-/);
  assert.ok(fs.existsSync(result.parsed.backup));
});

test("add --mcp 幂等：第二次不改文件", () => {
  const ws = workspace();
  runJson(ws, ["agent", "add", "--mcp", "mcp.json"]);
  const stat = fs.statSync(path.join(ws.project, "mcp.json")).mtimeMs;

  const again = runJson(ws, ["agent", "add", "--mcp", "mcp.json"]);
  assert.equal(again.status, 0);
  assert.equal(again.parsed.changed, false);
  assert.equal(again.parsed.backup, null);
  assert.equal(fs.statSync(path.join(ws.project, "mcp.json")).mtimeMs, stat);
});

test("add --mcp 遇到坏 JSON 不动文件", () => {
  const ws = workspace();
  const file = path.join(ws.project, "broken.json");
  fs.writeFileSync(file, "{not json");

  const result = run(ws, ["agent", "add", "--mcp", "broken.json"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_USAGE/);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json");
});

test("add --prompt 只打印提示词", () => {
  const ws = workspace();
  const result = run(ws, ["agent", "add", "--prompt"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# mo 任务派发契约/);
  assert.equal(fs.existsSync(path.join(ws.project, "mcp.json")), false);
});

test("add 缺目标时报用法错", () => {
  const ws = workspace();
  const result = run(ws, ["agent", "add"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_USAGE/);
});
