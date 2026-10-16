/**
 * 统一状态词表 —— 直接采用 A2A (Agent2Agent) 的 TaskState。
 * 业界标准，语义被论证过，不自己发明。
 *
 * 说明：idle 不是 A2A 的任务状态，而是我们 UI 层对「存在但无活跃任务」的渲染。
 * 任务本身只应处于下面这些状态之一。
 */
export const TASK = Object.freeze({
  SUBMITTED: "submitted",
  WORKING: "working",
  INPUT_REQUIRED: "input-required",
  AUTH_REQUIRED: "auth-required",
  COMPLETED: "completed",
  CANCELED: "canceled",
  FAILED: "failed",
  REJECTED: "rejected",
});

/** UI 层附加的「无活跃任务」渲染值，不属于 A2A。 */
export const IDLE = "idle";

export const INTERRUPTED = new Set([TASK.INPUT_REQUIRED, TASK.AUTH_REQUIRED]);
export const TERMINAL = new Set([TASK.COMPLETED, TASK.CANCELED, TASK.FAILED, TASK.REJECTED]);
export const ACTIVE = new Set([TASK.SUBMITTED, TASK.WORKING]);

export const LABELS = Object.freeze({
  [TASK.SUBMITTED]: "已提交",
  [TASK.WORKING]: "运行中",
  [TASK.INPUT_REQUIRED]: "等待回答",
  [TASK.AUTH_REQUIRED]: "等待授权",
  [TASK.COMPLETED]: "已完成",
  [TASK.CANCELED]: "已中断",
  [TASK.FAILED]: "失败",
  [TASK.REJECTED]: "已拒绝",
  [IDLE]: "空闲",
});

/** 需要立刻惊动用户的状态。 */
export function needsAttention(status) {
  return INTERRUPTED.has(status) || status === TASK.FAILED;
}
