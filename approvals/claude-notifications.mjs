/**
 * Claude Code Notification hook 的 notification_type -> mo-agent 通知语义。
 *
 * 目标：让 Claude Code 的通知和 DSH 的规范事件用同一套标题/级别，
 * 而不是所有类型都显示成「提醒」。Agent 名由 core/contract.mjs 统一拼到标题后面。
 */

import { SEVERITY } from "../core/contract.mjs";

export { SEVERITY };

const DEFAULT_NOTICE = Object.freeze({ title: "提醒", kind: "attention", severity: SEVERITY.CRITICAL });

export const CLAUDE_NOTIFICATION_MAP = Object.freeze({
  // 需要用户做决定
  permission_prompt: { title: "授权请求", kind: "approval", severity: SEVERITY.CRITICAL },
  worker_permission_prompt: { title: "授权请求", kind: "approval", severity: SEVERITY.CRITICAL },
  idle_prompt: { title: "等待回答", kind: "question", severity: SEVERITY.CRITICAL },
  agent_needs_input: { title: "等待回答", kind: "question", severity: SEVERITY.CRITICAL },
  elicitation_dialog: { title: "等待回答", kind: "question", severity: SEVERITY.CRITICAL },
  elicitation_url_dialog: { title: "等待回答", kind: "question", severity: SEVERITY.CRITICAL },

  // 任务状态
  agent_completed: { title: "任务完成", kind: "completed", severity: SEVERITY.NORMAL },

  // 账号 / 用量 / 电脑使用等状态提醒
  auth_success: { title: "登录成功", kind: "info", severity: SEVERITY.NORMAL },
  auth_storage_failure: { title: "登录异常", kind: "error", severity: SEVERITY.CRITICAL },
  quota_auto_resume_fired: { title: "用量恢复", kind: "info", severity: SEVERITY.NORMAL },
  quota_auto_resume_stale: { title: "用量限制", kind: "info", severity: SEVERITY.NORMAL },
  quota_auto_resume_disabled: { title: "用量限制", kind: "info", severity: SEVERITY.NORMAL },
  computer_use_enter: { title: "电脑操作", kind: "info", severity: SEVERITY.NORMAL },
  computer_use_exit: { title: "电脑操作", kind: "info", severity: SEVERITY.NORMAL },
  model_refusal_fallback: { title: "模型切换", kind: "info", severity: SEVERITY.NORMAL },

  // 插件 / 模型主动推送
  plugin_notification: { title: "提醒", kind: "attention", severity: SEVERITY.NORMAL },
  push_notification: { title: "提醒", kind: "attention", severity: SEVERITY.NORMAL },
});

// 这些通知和 PermissionRequest 是同一件事：权限 hook 已经会生成授权卡，
// 再发一条 notice 会在手机上出现两条重复通知。
const PERMISSION_NOTICE_TYPES = new Set(["permission_prompt", "worker_permission_prompt"]);

/** 有 PermissionRequest 能力的 Agent，不需要再为权限提示发一条重复通知。 */
export function shouldSkipNotice(notificationType, profile) {
  if (!PERMISSION_NOTICE_TYPES.has(String(notificationType || ""))) return false;
  const caps = (profile && profile.capabilities) || {};
  const approval = caps.approval || (profile && profile.approval && profile.approval.capability);
  return approval === "allow";
}

/** 把 Notification hook 输入压成 mo-agent 的 notice 字段。 */
export function describeClaudeNotification(input) {
  const raw = input || {};
  const type = typeof raw.notificationType === "string" ? raw.notificationType : "";
  const mapped = CLAUDE_NOTIFICATION_MAP[type] || DEFAULT_NOTICE;
  const body = typeof raw.message === "string" && raw.message
    ? raw.message
    : (typeof raw.toolName === "string" ? raw.toolName : "");
  return {
    notificationType: type || null,
    title: mapped.title,
    kind: mapped.kind,
    severity: mapped.severity,
    body,
  };
}
