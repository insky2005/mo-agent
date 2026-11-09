import test from "node:test";
import assert from "node:assert/strict";
import {
  ROUTER_FORBIDDEN_TOOLS,
  ROUTER_MCP_PATTERN,
  ROUTER_READ_TOOLS,
  ROUTER_TOOL_SPEC,
  TOOL_RESTRICTION,
  ROUTER_ERROR,
  admitRuntime,
  findForbiddenTool,
  isRouterToolAllowed,
  validateToolSpec,
} from "./router.mjs";

test("工具面常量：只读四个 + mo 的 MCP，顺序固定", () => {
  assert.deepEqual([...ROUTER_READ_TOOLS], ["read", "grep", "find", "ls"]);
  assert.equal(ROUTER_MCP_PATTERN, "mcp__mo__*");
  assert.equal(ROUTER_TOOL_SPEC, "read,grep,find,ls,mcp__mo__*");
});

test("工具面里不出现任何禁用工具", () => {
  assert.equal(findForbiddenTool(ROUTER_TOOL_SPEC), null);
  for (const name of ROUTER_FORBIDDEN_TOOLS) {
    assert.ok(!ROUTER_TOOL_SPEC.split(",").includes(name), "禁用了却还在白名单里: " + name);
  }
});

test("isRouterToolAllowed：只读与 mo 的 MCP 放行，其它一律拒绝", () => {
  for (const name of ["read", "grep", "find", "ls", "mcp__mo__task_create", "mcp__mo__note_write"]) {
    assert.equal(isRouterToolAllowed(name), true, name);
  }
  for (const name of ["bash", "edit", "write", "powershell", "mcp__other__read", "mcp__mo__", "", null, undefined]) {
    assert.equal(isRouterToolAllowed(name), false, String(name));
  }
});

test("准入：allowlist 放行，preset 放行但标注粒度，none 与服务缺失拒绝", () => {
  const allow = admitRuntime({ toolRestriction: "allowlist" });
  assert.equal(allow.ok, true);
  assert.equal(allow.level, TOOL_RESTRICTION.ALLOWLIST);
  assert.equal(allow.note, undefined);

  const preset = admitRuntime({ toolRestriction: "preset" });
  assert.equal(preset.ok, true);
  assert.equal(preset.level, TOOL_RESTRICTION.PRESET);
  assert.ok(preset.note && preset.note.includes("预设粒度"));

  for (const caps of [{ toolRestriction: "none" }, { toolRestriction: "whatever" }, {}, null]) {
    const denied = admitRuntime(caps);
    assert.equal(denied.ok, false, JSON.stringify(caps));
    assert.equal(denied.code, ROUTER_ERROR.RUNTIME_UNSUPPORTED);
    assert.equal(denied.level, TOOL_RESTRICTION.NONE);
    assert.ok(denied.reason);
  }
});

test("工具面校验：通配与越界都拒绝", () => {
  assert.equal(validateToolSpec(ROUTER_TOOL_SPEC).ok, true);
  assert.equal(validateToolSpec("read,mcp__mo__*").ok, true);

  for (const bad of ["", "*", "read,bash", "read,*", "mcp__other__*", "read,exec", " read , bash "]) {
    const result = validateToolSpec(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.reason, JSON.stringify(bad));
  }
});

test("准入失败的错误码稳定，UI 与文档都依赖它", () => {
  assert.equal(ROUTER_ERROR.RUNTIME_UNSUPPORTED, "E_ROUTER_RUNTIME_UNSUPPORTED");
  assert.equal(ROUTER_ERROR.NOT_ONBOARDED, "E_ROUTER_NOT_ONBOARDED");
  assert.equal(ROUTER_ERROR.NO_CREDENTIAL, "E_ROUTER_NO_CREDENTIAL");
});
