import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgent, listAgents, which, EXECUTORS } from "./lib/executors.mjs";

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
