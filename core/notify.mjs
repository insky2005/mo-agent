import { EVENT } from "./events.mjs";

/**
 * 通知分级：决定「怎么吵醒你」。
 *  - critical：需要人做决定（授权/回答/失败），强提醒（震动+语音+通知）
 *  - normal：完成类，静默出一条通知
 *  - info：纯提示
 */
export const SEVERITY = Object.freeze({
  CRITICAL: "critical",
  NORMAL: "normal",
  INFO: "info",
});

function describeQuestion(question) {
  if (!question) return "需要你的输入";
  const reason = question.reason || question.toolName;
  if (reason) return String(reason);
  const list = question.questions || [];
  const text = list
    .map((item) => (item && item.question) || "")
    .filter(Boolean)
    .join(" / ");
  return text || "需要你的输入";
}

/**
 * 把 hub 上的原始事件翻译成一条通知意图。
 * 返回 null 表示这条事件不值得打扰用户。
 */
export function classifyEvent(event) {
  const p = (event && event.payload) || {};
  switch (event.type) {
    case EVENT.APPROVAL_PENDING: {
      const label = p.agentLabel || p.agent || "Agent";
      return {
        severity: SEVERITY.CRITICAL,
        kind: "approval",
        title: "需要授权 · " + label,
        body: p.title || p.toolName || "该操作需要你的授权才能继续",
        eventId: p.id || null,
        sessionId: p.sessionId || null,
        agent: p.agent || null,
        toolName: p.toolName || null,
      };
    }
    case "pending.added": {
      const isApproval = p.kind === "approval";
      return {
        severity: SEVERITY.CRITICAL,
        kind: isApproval ? "approval" : "question",
        title: isApproval ? "需要授权" : "Agent 正在询问",
        body: describeQuestion(p.question),
        eventId: p.eventId || null,
        sessionId: p.sessionId || null,
        agent: null,
        toolName: null,
      };
    }
    case EVENT.NEEDS_AUTH:
    case EVENT.NEEDS_INPUT: {
      const isAuth = event.type === EVENT.NEEDS_AUTH;
      return {
        severity: SEVERITY.CRITICAL,
        kind: isAuth ? "approval" : "question",
        title: p.title || (isAuth ? "需要授权" : "Agent 正在询问"),
        body: p.body || p.text || "",
        eventId: p.id || p.eventId || null,
        sessionId: p.sessionId || null,
        agent: p.agent || null,
        toolName: p.toolName || null,
      };
    }
    case EVENT.NOTICE: {
      const kind = p.kind || "notice";
      return {
        severity: kind === "completed" ? SEVERITY.NORMAL : SEVERITY.CRITICAL,
        kind,
        title: p.title || "Agent 通知",
        body: p.body || "",
        eventId: null,
        sessionId: p.sessionId || null,
        agent: p.agent || null,
        toolName: null,
      };
    }
    case EVENT.RUN_FAILED: {
      return {
        severity: SEVERITY.CRITICAL,
        kind: "error",
        title: (p.title || p.agent || "Agent") + " 失败",
        body: p.text || p.body || "",
        eventId: null,
        sessionId: p.id || p.sessionId || null,
        agent: p.agent || null,
        toolName: null,
      };
    }
    default:
      return null;
  }
}

/** 去重键：同一件待办（授权/提问）只提醒一次。 */
export function notificationKey(event, intent) {
  if (intent.eventId) return event.type + ":" + intent.eventId;
  return event.type + ":" + event.seq;
}

/**
 * 通知路由：订阅统一事件流，翻译成 notify 事件广播给所有客户端
 * （手机 SSE / 将来的 webhook、Web Push 都挂在 channels 上）。
 */
export class Notifier {
  constructor(options) {
    const opts = options || {};
    this.hub = opts.hub;
    this.log = opts.log || (() => {});
    this.maxSeen = opts.maxSeen || 500;
    this.channels = [];
    this.seen = new Set();
    this.unsubscribe = null;
  }

  register(channel) {
    if (channel && typeof channel.send === "function") this.channels.push(channel);
    return channel;
  }

  start() {
    if (this.unsubscribe) return this.unsubscribe;
    this.unsubscribe = this.hub.store.subscribe((event) => this.handle(event));
    return this.unsubscribe;
  }

  stop() {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  handle(event) {
    if (!event || event.type === EVENT.NOTIFY) return;
    const intent = classifyEvent(event);
    if (!intent) return;
    const key = notificationKey(event, intent);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > this.maxSeen) this.seen = new Set();

    const payload = Object.assign({}, intent, { sourceSeq: event.seq, createdAt: Date.now() });
    this.log.info("通知 " + payload.severity + " · " + payload.title + (payload.body ? " · " + payload.body : ""));
    this.hub.emit(EVENT.NOTIFY, payload);
    for (const channel of this.channels) {
      try {
        const result = channel.send(payload);
        // webhook 等通道是异步的，失败只记日志，不能影响其它通道
        if (result && typeof result.then === "function") {
          result.catch((error) => this.fail(error));
        }
      } catch (error) {
        this.fail(error);
      }
    }
  }

  fail(error) {
    this.log.warn("通知通道发送失败: " + (error && error.message ? error.message : error));
  }
}
