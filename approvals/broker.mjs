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

    if (!this.isClientConnected()) {
      this.log.info("无手机在线，批准请求交回本地终端: " + key);
      return Promise.resolve({ decision: DECISION.DEFER, reason: "no-client", id: null });
    }

    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.hub.emit(EVENT.APPROVAL_RESOLVED, { id, decision: DECISION.DEFER, reason: "timeout" });
        this.log.warn("批准请求超时，交回本地终端: " + key);
        resolve({ decision: DECISION.DEFER, reason: "timeout", id });
      }, this.timeoutMs);

      this.pending.set(id, {
        id,
        key,
        payload,
        createdAt: Date.now(),
        finish: (decision, reason) => {
          clearTimeout(timer);
          this.pending.delete(id);
          if (decision === DECISION.ALLOW_ALWAYS || decision === DECISION.REJECT_ALWAYS) this.rules.set(key, decision);
          this.hub.emit(EVENT.APPROVAL_RESOLVED, { id, decision, reason: reason || "user" });
          resolve({ decision, reason: reason || "user", id });
        },
      });

      this.hub.emit(EVENT.APPROVAL_PENDING, {
        id,
        agent: payload.agent || "unknown",
        agentLabel: payload.agentLabel || payload.agent || "unknown",
        sessionId: payload.sessionId || null,
        toolName: payload.toolName || "",
        toolInput: payload.toolInput || null,
        title: payload.title || payload.toolName || "需要授权",
        createdAt: Date.now(),
        timeoutMs: this.timeoutMs,
      });
      this.log.info("已推送批准请求到手机: " + (payload.toolName || key));
    });
  }

  /** 手机做决定。 */
  decide(id, decision) {
    const item = this.pending.get(id);
    if (!item) return false;
    item.finish(decision, "user");
    return true;
  }

  list() {
    return [...this.pending.values()].map((p) => ({
      id: p.id,
      agent: p.payload.agent || "unknown",
      toolName: p.payload.toolName || "",
      title: p.payload.title || p.payload.toolName || "需要授权",
      createdAt: p.createdAt,
      sessionId: p.payload.sessionId || null,
    }));
  }

  cancelAll(reason) {
    for (const item of [...this.pending.values()]) item.finish(DECISION.DEFER, reason || "shutdown");
  }
}
