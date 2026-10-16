/**
 * 统一事件类型 —— 采用 AG-UI (Agent User Interaction Protocol) 的事件形态。
 * 各 adapter 把自己的原始信号翻译成这里的词汇，上层只认这一套。
 */
export const EVENT = Object.freeze({
  // Agent 生命周期（对应 AG-UI 的 Run/Step）
  AGENT_ADDED: "agent.added",
  AGENT_UPDATED: "agent.updated",
  AGENT_REMOVED: "agent.removed",
  RUN_STARTED: "agent.run.started",
  STEP_STARTED: "agent.step.started",
  STEP_FINISHED: "agent.step.finished",
  // 文本与工具（对应 AG-UI 的 TextMessage*/ToolCall*）
  TEXT_DELTA: "agent.text.delta",
  TOOL_STARTED: "agent.tool.started",
  TOOL_FINISHED: "agent.tool.finished",
  // 中断态（对应 AG-UI 的 RunFinished.outcome=interrupt）
  NEEDS_INPUT: "agent.needs.input",
  NEEDS_AUTH: "agent.needs.auth",
  // 终止态（对应 AG-UI 的 RunFinished / RunError）
  RUN_COMPLETED: "agent.run.completed",
  RUN_FAILED: "agent.run.failed",
  RUN_CANCELED: "agent.run.canceled",
  // 远程批准
  APPROVAL_PENDING: "approval.pending",
  APPROVAL_RESOLVED: "approval.resolved",
  // 其它
  NOTICE: "notice",
  SOURCE_ERROR: "source.error",
});
