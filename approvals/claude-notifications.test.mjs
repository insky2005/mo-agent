import test from "node:test";
import assert from "node:assert/strict";
import { describeClaudeNotification, CLAUDE_NOTIFICATION_MAP, shouldSkipNotice } from "./claude-notifications.mjs";

test("授权类通知映射成「授权请求」critical", () => {
  for (const type of ["permission_prompt", "worker_permission_prompt"]) {
    const notice = describeClaudeNotification({ notificationType: type, message: "x" });
    assert.equal(notice.title, "授权请求", type);
    assert.equal(notice.kind, "approval", type);
    assert.equal(notice.severity, "critical", type);
  }
});

test("等待输入类映射成「等待回答」critical", () => {
  for (const type of ["idle_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"]) {
    const notice = describeClaudeNotification({ notificationType: type, message: "x" });
    assert.equal(notice.title, "等待回答", type);
    assert.equal(notice.kind, "question", type);
    assert.equal(notice.severity, "critical", type);
  }
});

test("完成 / 登录 / 用量 / 电脑操作是普通级别", () => {
  for (const [type, title] of [
    ["agent_completed", "任务完成"],
    ["auth_success", "登录成功"],
    ["quota_auto_resume_fired", "用量恢复"],
    ["quota_auto_resume_stale", "用量限制"],
    ["quota_auto_resume_disabled", "用量限制"],
    ["computer_use_enter", "电脑操作"],
    ["computer_use_exit", "电脑操作"],
    ["model_refusal_fallback", "模型切换"],
  ]) {
    const notice = describeClaudeNotification({ notificationType: type, message: "x" });
    assert.equal(notice.title, title, type);
    assert.equal(notice.severity, "normal", type);
  }
});

test("正文优先用 message，没有时退回 toolName", () => {
  assert.equal(describeClaudeNotification({ notificationType: "idle_prompt", message: "Claude is waiting for your input" }).body, "Claude is waiting for your input");
  assert.equal(describeClaudeNotification({ notificationType: "permission_prompt", toolName: "Bash" }).body, "Bash");
  assert.equal(describeClaudeNotification({ notificationType: "idle_prompt" }).body, "");
});

test("未知类型保持原来的「提醒」critical，且不改正文", () => {
  const notice = describeClaudeNotification({ notificationType: "something_new", message: "hi" });
  assert.equal(notice.title, "提醒");
  assert.equal(notice.kind, "attention");
  assert.equal(notice.severity, "critical");
  assert.equal(notice.body, "hi");
  assert.equal(notice.notificationType, "something_new");
});

test("内置 17 种类型都有映射", () => {
  const types = ["permission_prompt", "idle_prompt", "auth_success", "elicitation_dialog", "agent_needs_input", "agent_completed", "elicitation_url_dialog", "worker_permission_prompt", "push_notification", "computer_use_enter", "computer_use_exit", "quota_auto_resume_fired", "quota_auto_resume_stale", "quota_auto_resume_disabled", "model_refusal_fallback", "auth_storage_failure", "plugin_notification"];
  for (const type of types) assert.ok(CLAUDE_NOTIFICATION_MAP[type], type);
  assert.equal(types.length, 17);
});

test("已有 PermissionRequest 的 Agent 不再推重复的权限 notice", () => {
  const qoder = { capabilities: { approval: "allow" } };
  assert.equal(shouldSkipNotice("permission_prompt", qoder), true);
  assert.equal(shouldSkipNotice("worker_permission_prompt", qoder), true);
  assert.equal(shouldSkipNotice("idle_prompt", qoder), false);
  assert.equal(shouldSkipNotice("elicitation_dialog", qoder), false);
  assert.equal(shouldSkipNotice("permission_prompt", { capabilities: { approval: "none" } }), false);
  assert.equal(shouldSkipNotice("permission_prompt", null), false);
});
