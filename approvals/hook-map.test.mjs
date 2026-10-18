import test from "node:test";
import assert from "node:assert/strict";
import { loadProfile, mapHookEvent, hookTarget } from "./hook-map.mjs";

test("Claude profile 的 hook 映射指向规范事件", () => {
  const profile = loadProfile("claude-code");
  assert.ok(profile);
  assert.equal(mapHookEvent(profile, "PermissionRequest"), "approval.pending");
  assert.equal(mapHookEvent(profile, "Notification"), "notice");
  assert.equal(mapHookEvent(profile, "Unknown"), "");
});

test("event 模式按 profile 映射，旧模式保持兼容", () => {
  const profile = loadProfile("claude-code");
  assert.equal(hookTarget("event", profile, "PermissionRequest"), "approval.pending");
  assert.equal(hookTarget("event", profile, "Notification"), "notice");
  assert.equal(hookTarget("permission", profile), "approval.pending");
  assert.equal(hookTarget("notify", profile), "notice");
  assert.equal(hookTarget("other", profile), "");
});

test("未知 Agent 不抛错", () => {
  assert.equal(loadProfile("does-not-exist"), null);
  assert.equal(hookTarget("event", null, "Notification"), "");
});
