import { TASK, IDLE } from "./status.mjs";

/**
 * 规范事件与映射契约（v1）。
 *
 * 这里只放“稳定”的东西：
 *  - 事件名（唯一事实源）
 *  - 旧事件名别名（迁移期）
 *  - 事件元数据（状态/信号、是否重放、必填字段）
 *  - 通知策略（唯一“事件 -> 通知意图”映射）
 *
 * 厂商原始事件、字段解析留在各 adapter；UI 文案留在 app。适配器不得发 notify。
 */
export const EVENT = Object.freeze({
  // 规范事件
  SESSION_UPSERT: "session.upsert",
  SESSION_REMOVED: "session.removed",
  RUN_STARTED: "run.started",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",
  RUN_CANCELED: "run.canceled",
  PENDING_ADDED: "pending.added",
  PENDING_RESOLVED: "pending.resolved",
  APPROVAL_PENDING: "approval.pending",
  APPROVAL_RESOLVED: "approval.resolved",
  NOTICE: "notice",
  SOURCE_ERROR: "source.error",
  NOTIFY: "notify",

  // 迁移期别名（不要在新增代码里使用）
  AGENT_ADDED: "agent.added",
  AGENT_UPDATED: "agent.updated",
  AGENT_REMOVED: "agent.removed",
  AGENT_RUN_STARTED: "agent.run.started",
  AGENT_RUN_COMPLETED: "agent.run.completed",
  AGENT_RUN_FAILED: "agent.run.failed",
  AGENT_RUN_CANCELED: "agent.run.canceled",
  AGENT_NEEDS_INPUT: "agent.needs.input",
  AGENT_NEEDS_AUTH: "agent.needs.auth",
  SESSION_STARTED: "session.started",
  DSH_ERROR: "dsh.error",
});

/** 旧名 -> 规范名。只在 Hub 入口归一化一次。 */
export const LEGACY_ALIASES = Object.freeze({
  [EVENT.AGENT_ADDED]: EVENT.SESSION_UPSERT,
  [EVENT.AGENT_UPDATED]: EVENT.SESSION_UPSERT,
  [EVENT.AGENT_REMOVED]: EVENT.SESSION_REMOVED,
  [EVENT.AGENT_RUN_STARTED]: EVENT.RUN_STARTED,
  [EVENT.AGENT_RUN_COMPLETED]: EVENT.RUN_COMPLETED,
  [EVENT.AGENT_RUN_FAILED]: EVENT.RUN_FAILED,
  [EVENT.AGENT_RUN_CANCELED]: EVENT.RUN_CANCELED,
});

/**
 * 每个规范事件的元数据。
 * category: state（幂等，可重放）/ signal（一次性，通知来源）/ derived（派生输出）
 * required: 必填 payload 字段
 */
export const EVENT_META = Object.freeze({
  [EVENT.SESSION_UPSERT]: {
    category: "state",
    replay: true,
    required: ["sessionId", "agent", "status", "running", "updatedAt"],
  },
  [EVENT.SESSION_REMOVED]: { category: "state", replay: true, required: ["sessionId"] },
  [EVENT.RUN_STARTED]: { category: "signal", replay: false, required: ["runId", "sessionId"] },
  [EVENT.RUN_COMPLETED]: { category: "signal", replay: false, required: ["runId", "sessionId"] },
  [EVENT.RUN_FAILED]: { category: "signal", replay: false, required: ["runId", "sessionId"] },
  [EVENT.RUN_CANCELED]: { category: "signal", replay: false, required: ["runId", "sessionId"] },
  [EVENT.PENDING_ADDED]: { category: "state", replay: true, required: ["eventId", "sessionId"] },
  [EVENT.PENDING_RESOLVED]: { category: "state", replay: true, required: ["eventId"] },
  [EVENT.APPROVAL_PENDING]: { category: "state", replay: true, required: ["id"] },
  [EVENT.APPROVAL_RESOLVED]: { category: "state", replay: true, required: ["id"] },
  [EVENT.NOTICE]: { category: "signal", replay: false, required: ["title"] },
  // 迁移期：旧 hook/适配器可能还在发这两个事件
  [EVENT.AGENT_NEEDS_AUTH]: { category: "signal", replay: false, required: [] },
  [EVENT.AGENT_NEEDS_INPUT]: { category: "signal", replay: false, required: [] },
  [EVENT.SOURCE_ERROR]: { category: "state", replay: true, required: ["source", "message"] },
  [EVENT.NOTIFY]: { category: "derived", replay: false, required: ["severity", "kind", "title"] },
});

/** 明确不会产生通知的事件；与 NOTIFY_POLICY 互补，测试会检查完整性。 */
export const SILENT_EVENTS = Object.freeze(new Set([
  EVENT.SESSION_UPSERT,
  EVENT.SESSION_REMOVED,
  EVENT.RUN_STARTED,
  EVENT.PENDING_RESOLVED,
  EVENT.APPROVAL_RESOLVED,
  EVENT.SOURCE_ERROR,
  // 迁移期：手机端仍在用的旧事件
  EVENT.SESSION_STARTED,
  EVENT.DSH_ERROR,
]));

export const STATE_EVENTS = Object.freeze(new Set(
  Object.entries(EVENT_META).filter(([, meta]) => meta.category === "state").map(([type]) => type)
));
export const SIGNAL_EVENTS = Object.freeze(new Set(
  Object.entries(EVENT_META).filter(([, meta]) => meta.category === "signal").map(([type]) => type)
));

/** 把旧事件名归一化成规范名；未知事件返回 null。 */
export function canonicalEventType(type) {
  if (EVENT_META[type]) return type;
  return LEGACY_ALIASES[type] || null;
}

export function isKnownEventType(type) {
  return !!canonicalEventType(type) || type === EVENT.SESSION_STARTED || type === EVENT.DSH_ERROR;
}

/** 统一生成 runId：同一轮的开始与结束必须用同一个 key。 */
export function makeRunId(sessionId, turnKey) {
  return String(sessionId) + ":turn:" + String(turnKey);
}

function text(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/** 通知正文里的来源：Agent 名 + 会话标题，避免只看到标题分不清谁。 */
function labelOf(payload) {
  return [payload.agentLabel, payload.sessionTitle].filter(Boolean).join(" · ");
}

/** 会话是否具备某个控制能力（prompt / cancel）。缺 capabilities 时兼容旧 DSH 快照。 */
export function canControl(session, action) {
  if (!session) return false;
  const caps = session.capabilities;
  if (caps && Array.isArray(caps.control)) return caps.control.includes(action);
  return session.agent !== "claude-code";
}

/** 正文前缀：优先会话标题，没有就退回 Agent 名。 */
export function withPrefix(prefix, body) {
  const head = text(prefix);
  const tail = text(body);
  if (head && tail) return head + " · " + tail;
  return head || tail;
}

/** 通知正文别太长：手机通知栏只显示前几行，HMS 也不适合塞整段回答。 */
export function clip(value, max) {
  const body = text(value);
  const limit = max || 400;
  return body.length > limit ? body.slice(0, limit - 1) + "…" : body;
}

export function describeQuestion(question) {
  if (!question) return "需要你的输入";
  const reason = question.reason || question.toolName;
  if (reason) return String(reason);
  const list = question.questions || [];
  const value = list
    .map((item) => (item && item.question) || "")
    .filter(Boolean)
    .join(" / ");
  return value || "需要你的输入";
}

export const SEVERITY = Object.freeze({
  CRITICAL: "critical",
  NORMAL: "normal",
  INFO: "info",
});

/**
 * 唯一“事件 -> 通知意图”映射。
 * 每个规范事件必须出现在这里或 SILENT_EVENTS 中；contract.test 会检查。
 * 返回 null 表示这条事件不通知。
 */
export const NOTIFY_POLICY = Object.freeze({
  [EVENT.APPROVAL_PENDING]: (p) => ({
    severity: SEVERITY.CRITICAL,
    kind: "approval",
    title: "授权请求",
    body: withPrefix(p.agentLabel || p.agent || "Agent", p.title || p.toolName || "该操作需要你的授权才能继续"),
    eventId: p.id || null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    toolName: p.toolName || null,
  }),

  [EVENT.PENDING_ADDED]: (p) => {
    const isApproval = p.kind === "approval";
    return {
      severity: SEVERITY.CRITICAL,
      kind: isApproval ? "approval" : "question",
      title: isApproval ? "授权请求" : "等待回答",
      body: withPrefix(labelOf(p), describeQuestion(p.question)),
      eventId: p.eventId || null,
      sessionId: p.sessionId || null,
      agent: null,
      toolName: null,
    };
  },

  [EVENT.AGENT_NEEDS_AUTH]: (p) => ({
    severity: SEVERITY.CRITICAL,
    kind: "approval",
    title: "授权请求",
    body: withPrefix(p.sessionTitle || p.agentLabel || p.agent, p.title || p.body || p.text || ""),
    eventId: p.id || p.eventId || null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    toolName: p.toolName || null,
  }),

  [EVENT.AGENT_NEEDS_INPUT]: (p) => ({
    severity: SEVERITY.CRITICAL,
    kind: "question",
    title: "等待回答",
    body: withPrefix(p.sessionTitle || p.agentLabel || p.agent, p.title || p.body || p.text || ""),
    eventId: p.id || p.eventId || null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    toolName: p.toolName || null,
  }),

  [EVENT.NOTICE]: (p) => {
    const kind = p.kind || "notice";
    const fixedTitle = kind === "completed" ? "任务完成" : kind === "error" ? "出错了" : "";
    return {
      severity: kind === "completed" ? SEVERITY.NORMAL : SEVERITY.CRITICAL,
      kind,
      title: fixedTitle || p.title || "提醒",
      body: withPrefix(labelOf(p), p.body || ""),
      eventId: null,
      sessionId: p.sessionId || null,
      agent: p.agent || null,
      toolName: null,
    };
  },

  [EVENT.RUN_COMPLETED]: (p) => ({
    severity: SEVERITY.NORMAL,
    kind: "completed",
    title: "任务完成",
    body: withPrefix(labelOf(p) || p.title || p.agent, clip(p.text || p.body || "")),
    eventId: null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    agentLabel: p.agentLabel || null,
    toolName: null,
    runId: p.runId || null,
  }),

  [EVENT.RUN_FAILED]: (p) => ({
    severity: SEVERITY.CRITICAL,
    kind: "error",
    title: "出错了",
    body: withPrefix(labelOf(p) || p.title || p.agent, clip(p.text || p.body || "")),
    eventId: null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    agentLabel: p.agentLabel || null,
    toolName: null,
    runId: p.runId || null,
  }),

  [EVENT.RUN_CANCELED]: (p) => ({
    severity: SEVERITY.NORMAL,
    kind: "canceled",
    title: "已中断",
    body: withPrefix(labelOf(p) || p.title || p.agent, ""),
    eventId: null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    agentLabel: p.agentLabel || null,
    toolName: null,
    runId: p.runId || null,
  }),
});

/** 轻量 payload 校验：缺字段时返回错误列表，供 contract.test 使用。 */
export function missingFields(type, payload) {
  const meta = EVENT_META[type];
  if (!meta) return [];
  const p = payload || {};
  return meta.required.filter((key) => p[key] === undefined || p[key] === null || p[key] === "");
}

/** 状态辅助：终态集合。 */
export const TERMINAL_STATUSES = Object.freeze(new Set([
  TASK.COMPLETED,
  TASK.FAILED,
  TASK.CANCELED,
  TASK.REJECTED,
]));

export function hasResponseText(value) {
  return text(value).length > 0;
}

export { TASK, IDLE };
