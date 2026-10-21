import { randomUUID } from "node:crypto";
import { EVENT } from "../core/events.mjs";

export const DECISION = Object.freeze({
  ALLOW_ONCE: "allow_once",
  ALLOW_ALWAYS: "allow_always",
  REJECT_ONCE: "reject_once",
  REJECT_ALWAYS: "reject_always",
  DEFER: "defer",
});

/**
 * 远程批准中枢。
 *
 * 核心设计（ADR-0001）：失败要「交回本地终端」，不能 fail-open 也不能 fail-closed。
 *  - 手机在线   → 挂起等待，人来做决定
 *  - 手机不在线 → 立即返回 DEFER，hook 退出码 0，用户在终端照常看到提示
 *  - 超时       → 同上
 */
export class ApprovalBroker {
  constructor(options) {
    const opts = options || {};
    this.hub = opts.hub;
    this.log = opts.log || (() => {});
    this.timeoutMs = opts.timeoutMs || 120000;
    this.isClientConnected = opts.isClientConnected || (() => false);
    // 有推送设备但 App 还没连上时，先挂起一小会儿等它连上来（用户可能正被推送叫醒）。
    this.noClientGraceMs = Number(opts.noClientGraceMs) > 0 ? Number(opts.noClientGraceMs) : 0;
    this.hasRemoteClient = typeof opts.hasRemoteClient === "function" ? opts.hasRemoteClient : null;
    // 语音等其它决策端可以订阅这个回调，拿到 pending 的 id 后再回 decide。
    this.onPending = opts.onPending || null;
    this.pending = new Map();
    this.rules = new Map();
  }

  ruleKey(payload) {
    return (payload.agent || "unknown") + "::" + (payload.toolName || "unknown");
  }

  /** hook 调用入口：返回最终决策。 */
  request(payload) {
    const key = this.ruleKey(payload);
    const remembered = this.rules.get(key);
    if (remembered) {
      this.log.info("命中已记住的批准规则 " + key + " -> " + remembered);
      return Promise.resolve({ decision: remembered, reason: "remembered", id: null });
    }

    const connected = this.isClientConnected();
    const reachable = connected || (this.hasRemoteClient ? this.hasRemoteClient() : false);
    if (!reachable) {
      this.log.info("无手机在线，批准请求交回本地终端: " + key);
      return Promise.resolve({ decision: DECISION.DEFER, reason: "no-client", id: null });
    }
    if (!connected) {
      this.log.info("手机还没连上，先挂起等它 " + Math.round(this.noClientGraceMs / 1000) + " 秒: " + key);
    }

    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.hub.emit(EVENT.APPROVAL_RESOLVED, { id, decision: DECISION.DEFER, reason: "timeout" });
        this.log.warn("批准请求超时，交回本地终端: " + key);
        resolve({ decision: DECISION.DEFER, reason: "timeout", id });
      }, this.timeoutMs);

      const item = {
        id,
        key,
        payload,
        createdAt: Date.now(),
        finish: (decision, reason, extra) => {
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          this.pending.delete(id);
          if (decision === DECISION.ALLOW_ALWAYS || decision === DECISION.REJECT_ALWAYS) this.rules.set(key, decision);
          this.hub.emit(EVENT.APPROVAL_RESOLVED, { id, decision, reason: reason || "user" });
          resolve(Object.assign({ decision, reason: reason || "user", id }, extra || {}));
        },
      };
      this.pending.set(id, item);

      // 推送已发但 App 可能还在后台/冷启动：给一个很短的窗口，连上后照常走 120s 超时。
      const graceTimer = (!connected && this.noClientGraceMs > 0)
        ? setTimeout(() => {
          if (this.isClientConnected()) return;
          if (!this.pending.has(id)) return;
          clearTimeout(timer);
          this.pending.delete(id);
          this.hub.emit(EVENT.APPROVAL_RESOLVED, { id, decision: DECISION.DEFER, reason: "no-client" });
          this.log.warn("手机仍未连接，批准请求交回本地终端: " + key);
          resolve({ decision: DECISION.DEFER, reason: "no-client", id });
        }, this.noClientGraceMs)
        : null;

      this.hub.emit(EVENT.APPROVAL_PENDING, {
        id,
        agent: payload.agent || "unknown",
        agentLabel: payload.agentLabel || payload.agent || "unknown",
        sessionId: payload.sessionId || null,
        sessionTitle: payload.sessionTitle || null,
        toolName: payload.toolName || "",
        toolInput: payload.toolInput || null,
        kind: payload.kind === "question" ? "question" : "approval",
        questions: Array.isArray(payload.questions) ? payload.questions : null,
        title: payload.title || payload.toolName || "需要授权",
        createdAt: Date.now(),
        timeoutMs: this.timeoutMs,
      });
      this.log.info("已推送批准请求到手机: " + (payload.toolName || key));
      if (this.onPending) {
        try {
          this.onPending(item);
        } catch (error) {
          this.log.warn("onPending 回调失败: " + (error && error.message ? error.message : String(error)));
        }
      }
    });
  }

  /** 手机做决定；提问类可以带 answers。 */
  decide(id, decision, extra) {
    const item = this.pending.get(id);
    if (!item) return false;
    item.finish(decision, "user", extra);
    return true;
  }

  list() {
    return [...this.pending.values()].map((p) => ({
      id: p.id,
      agent: p.payload.agent || "unknown",
      agentLabel: p.payload.agentLabel || null,
      toolName: p.payload.toolName || "",
      toolInput: p.payload.toolInput || null,
      kind: p.payload.kind === "question" ? "question" : "approval",
      questions: Array.isArray(p.payload.questions) ? p.payload.questions : null,
      title: p.payload.title || p.payload.toolName || "需要授权",
      createdAt: p.createdAt,
      sessionId: p.payload.sessionId || null,
      sessionTitle: p.payload.sessionTitle || null,
      timeoutMs: this.timeoutMs,
    }));
  }

  cancelAll(reason) {
    for (const item of [...this.pending.values()]) item.finish(DECISION.DEFER, reason || "shutdown");
  }
}
