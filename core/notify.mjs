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
    if (this.seen.size > this.maxSeen) this.seen = new Set();

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

  fail(error) {
    this.log.warn("通知通道发送失败: " + (error && error.message ? error.message : error));
  }
}
