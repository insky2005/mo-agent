import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgent, listAgents, which, binaryOf, workerStatus, EXECUTORS } from "./lib/executors.mjs";

test("已知模板展开成完整命令", () => {
  const claude = resolveAgent("claude");
  assert.equal(claude.name, "claude");
  assert.match(claude.command, /^claude -p /);
  assert.match(resolveAgent("codex").command, /^codex exec -s workspace-write/);
});

test("未知模板报 E_USAGE 并给候选", () => {
  assert.throws(
    () => resolveAgent("claude-code"),
    (error) => {
      const hint = String((error.details && error.details.hint) || "");
      return error.code === "E_USAGE" && hint.includes("claude") && hint.includes("codex");
    },
  );
});

test("模板表不为空且字段齐全", () => {
  const agents = listAgents();
  assert.ok(agents.length >= 2);
  for (const agent of agents) {
    assert.ok(agent.name && agent.command && agent.description && agent.requires);
  }
});

test("模板命令都从 stdin 取 prompt", () => {
  for (const [name, preset] of Object.entries(EXECUTORS)) {
    const readsStdin = preset.command.includes("$(cat)") || /(^|\s)-$/.test(preset.command);
    assert.ok(readsStdin, name + " 看起来不读 stdin");
  }
});
test("which 能找到 node，找不到的返回 null", () => {
  assert.ok(which("node"));
  assert.equal(which("definitely-not-a-real-binary-xyz"), null);
});

test("listAgents 带 installed 与 path", () => {
  for (const agent of listAgents()) {
    assert.equal(typeof agent.installed, "boolean");
    if (agent.installed) assert.ok(agent.path);
  }
});
test("binaryOf 取命令里真正执行的程序", () => {
  assert.equal(binaryOf('claude -p "$(cat)"'), "claude");
  assert.equal(binaryOf("codex exec -s workspace-write -"), "codex");
  assert.equal(binaryOf('FOO=1 BAR=2 node "x y.mjs"'), "node");
  assert.equal(binaryOf("bash -lc 'claude -p hi'"), "claude");
  assert.equal(binaryOf("sh -c \"codex exec -\""), "codex");
  assert.equal(binaryOf("env FOO=1 /usr/local/bin/qwen --approval-mode auto-edit x"), "/usr/local/bin/qwen");
  assert.equal(binaryOf("nohup node run.mjs"), "node");
  assert.equal(binaryOf("/bin/bash script.sh"), "/bin/bash");
});

test("PATH 为空时所有模板都标为未安装", () => {
  const before = process.env.PATH;
  process.env.PATH = "";
  try {
    const agents = listAgents();
    assert.ok(agents.every((agent) => agent.installed === false));
    assert.ok(agents.every((agent) => agent.binary));
  } finally {
    process.env.PATH = before;
  }
});
test("workerStatus 同时校验命令程序与 requires", () => {
  const before = process.env.PATH;
  process.env.PATH = "";
  try {
    const status = workerStatus({ command: "node run.mjs", requires: "claude" });
    assert.equal(status.installed, false);
    assert.deepEqual(status.missing.sort(), ["claude", "node"]);
  } finally {
    process.env.PATH = before;
  }
});

test("没有 requires 时只看命令程序", () => {
  const before = process.env.PATH;
  process.env.PATH = "";
  try {
    const status = workerStatus({ command: "node run.mjs" });
    assert.deepEqual(status.missing, ["node"]);
  } finally {
    process.env.PATH = before;
  }
});
