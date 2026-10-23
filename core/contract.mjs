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
]));

export const STATE_EVENTS = Object.freeze(new Set(
  Object.entries(EVENT_META).filter(([, meta]) => meta.category === "state").map(([type]) => type)
));
export const SIGNAL_EVENTS = Object.freeze(new Set(
  Object.entries(EVENT_META).filter(([, meta]) => meta.category === "signal").map(([type]) => type)
));

/** 未知事件返回 null；M4 起不再接受旧别名。 */
export function canonicalEventType(type) {
  return EVENT_META[type] ? type : null;
}

export function isKnownEventType(type) {
  return !!canonicalEventType(type);
}

/** 统一生成 runId：同一轮的开始与结束必须用同一个 key。 */
export function makeRunId(sessionId, turnKey) {
  return String(sessionId) + ":turn:" + String(turnKey);
}

function text(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/** 标题后缀：Agent 名放方括号里，多 Agent 时手机通知栏一眼能分清。 */
function titleWithAgent(base, agentLabel) {
  const title = text(base);
  const label = text(agentLabel);
  if (!label) return title;
  const suffix = " [" + label + "]";
  // 自定义标题已经带过同样的后缀时不再重复
  return title.endsWith(suffix) ? title : title + suffix;
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
  [EVENT.APPROVAL_PENDING]: (p) => {
    // AskUserQuestion 也会走 PermissionRequest：它本质是「提问」，不是「授权」。
    const isQuestion = p.kind === "question";
    return {
      severity: SEVERITY.CRITICAL,
      kind: isQuestion ? "question" : "approval",
      title: titleWithAgent(isQuestion ? "等待回答" : "授权请求", p.agentLabel),
      body: withPrefix(
        p.sessionTitle,
        isQuestion
          ? describeQuestion({ questions: p.questions })
          : (p.title || p.toolName || "该操作需要你的授权才能继续")
      ),
      requiresAction: true,
      eventId: p.id || null,
      sessionId: p.sessionId || null,
      agent: p.agent || null,
      agentLabel: p.agentLabel || null,
      sessionTitle: p.sessionTitle || null,
      toolName: p.toolName || null,
    };
  },

  [EVENT.PENDING_ADDED]: (p) => {
    const isApproval = p.kind === "approval";
    return {
      severity: SEVERITY.CRITICAL,
      kind: isApproval ? "approval" : "question",
      title: titleWithAgent(isApproval ? "授权请求" : "等待回答", p.agentLabel),
      body: withPrefix(p.sessionTitle, describeQuestion(p.question)),
      requiresAction: true,
      eventId: p.eventId || null,
      sessionId: p.sessionId || null,
      agent: null,
      agentLabel: p.agentLabel || null,
      sessionTitle: p.sessionTitle || null,
      toolName: null,
    };
  },

  // notice 用于 hook 的「需要关注」；severity / kind 由来源声明
  // （Claude 的 notification_type 会映射成授权请求 / 等待回答 / 任务完成…），
  // 没有声明时保持 critical。
  [EVENT.NOTICE]: (p) => ({
    severity: p.severity || SEVERITY.CRITICAL,
    kind: p.kind || "attention",
    title: titleWithAgent(p.title || "提醒", p.agentLabel),
    body: withPrefix(p.sessionTitle, p.body || ""),
    eventId: null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    agentLabel: p.agentLabel || null,
    sessionTitle: p.sessionTitle || null,
    notificationType: p.notificationType || null,
    requiresAction: p.requiresAction === true || p.kind === "approval" || p.kind === "question",
    toolName: null,
  }),

  [EVENT.RUN_COMPLETED]: (p) => ({
    severity: SEVERITY.NORMAL,
    kind: "completed",
    title: titleWithAgent("任务完成", p.agentLabel),
    body: withPrefix(p.sessionTitle || p.title, clip(p.text || p.body || "")),
    eventId: null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    agentLabel: p.agentLabel || null,
    sessionTitle: p.sessionTitle || null,
    requiresAction: false,
    toolName: null,
    runId: p.runId || null,
  }),

  [EVENT.RUN_FAILED]: (p) => ({
    severity: SEVERITY.CRITICAL,
    kind: "error",
    title: titleWithAgent("出错了", p.agentLabel),
    body: withPrefix(p.sessionTitle || p.title, clip(p.text || p.body || "")),
    eventId: null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    agentLabel: p.agentLabel || null,
    sessionTitle: p.sessionTitle || null,
    requiresAction: true,
    toolName: null,
    runId: p.runId || null,
  }),

  [EVENT.RUN_CANCELED]: (p) => ({
    severity: SEVERITY.NORMAL,
    kind: "canceled",
    title: titleWithAgent("已中断", p.agentLabel),
    body: withPrefix(p.sessionTitle || p.title, ""),
    eventId: null,
    sessionId: p.sessionId || null,
    agent: p.agent || null,
    agentLabel: p.agentLabel || null,
    sessionTitle: p.sessionTitle || null,
    requiresAction: false,
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
