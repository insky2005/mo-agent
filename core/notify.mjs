import { EVENT, NOTIFY_POLICY, SEVERITY } from "./contract.mjs";

export { SEVERITY } from "./contract.mjs";

/**
 * 把 hub 上的原始事件翻译成一条通知意图。
 * 映射表在 core/contract.mjs 的 NOTIFY_POLICY；这里只做查表。
 * 返回 null 表示这条事件不值得打扰用户。
 */
export function classifyEvent(event) {
  if (!event || event.type === EVENT.NOTIFY) return null;
  const policy = NOTIFY_POLICY[event.type];
  if (!policy) return null;
  return policy((event && event.payload) || {}, event);
}

/** "HH:MM" → 当天分钟数；非法返回 null。 */
export function parseClock(value) {
  const matched = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value == null ? "" : value).trim());
  if (!matched) return null;
  return Number(matched[1]) * 60 + Number(matched[2]);
}

/**
 * 是否落在静音时段（支持跨零点，如 22:30–08:00）。
 * 配置形如 { start: "22:30", end: "08:00", allowCritical: true }；enabled:false 直接关闭。
 */
export function inQuietHours(now, quietHours) {
  const config = quietHours || {};
  if (config.enabled === false) return false;
  const start = parseClock(config.start);
  const end = parseClock(config.end);
  if (start === null || end === null || start === end) return false;
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** 去重键：同一轮完成用 runId，同一件待办用 eventId，其余用 seq。 */
export function notificationKey(event, intent) {
  if (intent.runId) return "run:" + intent.runId;
  if (intent.eventId) return event.type + ":" + intent.eventId;
  return event.type + ":" + event.seq;
}

/**
 * 通知路由：订阅统一事件流，翻译成 notify 事件广播给所有客户端
 * （手机 SSE / webhook / Web Push 都挂在 channels 上）。
 */
export class Notifier {
  constructor(options) {
    const opts = options || {};
    this.hub = opts.hub;
    this.log = opts.log || (() => {});
    this.maxSeen = opts.maxSeen || 500;
    this.quietHours = opts.quietHours || null;
    this.now = opts.now || (() => new Date());
    this.channels = [];
    this.seen = new Set();
    this.unsubscribe = null;
  }

  register(channel) {
    if (channel && typeof channel.send === "function") this.channels.push(channel);
    return channel;
  }

  unregister(channel) {
    this.channels = this.channels.filter((item) => item !== channel);
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
    // 逐条淘汰最旧的，而不是整表清空——整表清空会让刚发过的通知又冒一遍
    if (this.seen.size > this.maxSeen) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    if (this.isQuiet(intent)) {
      this.log.info("静音时段，跳过通知：" + intent.severity + " · " + intent.title);
      return;
    }

    const payload = Object.assign({}, intent, { sourceSeq: event.seq, createdAt: Date.now() });
    this.log.info("通知 " + payload.severity + " · " + payload.title + (payload.body ? " · " + payload.body : ""));
    this.hub.emit(EVENT.NOTIFY, payload);
    for (const channel of this.channels) {
      try {
        if (typeof channel.accepts === "function" && !channel.accepts(payload)) continue;
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

  /** 静音时段只挡"不紧急"的通知；critical（授权/报错）默认始终放行。 */
  isQuiet(intent) {
    if (!this.quietHours) return false;
    if (this.quietHours.allowCritical !== false && intent && intent.severity === SEVERITY.CRITICAL) return false;
    return inQuietHours(this.now(), this.quietHours);
  }

  fail(error) {
    this.log.warn("通知通道发送失败: " + (error && error.message ? error.message : error));
  }
}
