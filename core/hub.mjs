import { EventStore } from "./store.mjs";
import { EVENT } from "./events.mjs";
import { IDLE } from "./status.mjs";

/**
 * 统一状态中枢：所有 adapter 把原始信号翻译成统一事件后交给 Hub，
 * Hub 负责去重、排序、缓存（供断线重放）与对外快照。
 * 上层（host / app / desktop）只认这里的一套。
 */
export class Hub {
  constructor(options) {
    const opts = options || {};
    this.log = opts.log || (() => {});
    this.store = new EventStore(opts.historySize || 800);
    this.agents = new Map();
    this.adapters = new Map();
    this.startedAt = Date.now();
  }

  register(adapter) {
    this.adapters.set(adapter.name, adapter);
    this.log.info("已注册数据源: " + adapter.name);
    return adapter;
  }

  /** 发出一条事件：先入缓冲，再更新内存状态。 */
  emit(type, payload) {
    const data = payload || {};
    const event = this.store.push(type, data);
    this.applyEvent(type, data);
    return event;
  }

  applyEvent(type, data) {
    if (type === EVENT.AGENT_UPDATED || type === "session.upsert" || type === EVENT.AGENT_ADDED) {
      const agent = this.normalize(data);
      this.agents.set(agent.id, agent);
      return;
    }
    if (type === EVENT.AGENT_REMOVED || type === "session.removed") {
      const id = data.id || data.sessionId;
      if (id) this.agents.delete(id);
    }
  }

  /** 把各 adapter 的不同字段名归一成一份记录。 */
  normalize(payload) {
    const id = payload.id || payload.sessionId || payload.agentId;
    return {
      id,
      sessionId: id,
      parentId: payload.parentId || null,
      blank: !!payload.blank,
      agent: payload.agent || payload.source || "unknown",
      title: payload.title || id,
      cwd: payload.cwd || "",
      status: payload.status || IDLE,
      running: !!payload.running,
      updatedAt: payload.updatedAt || Date.now(),
      lastPrompt: payload.lastPrompt || "",
      lastResponse: payload.lastResponse || "",
      turns: payload.turns || 0,
      pending: payload.pending || [],
      detail: payload.detail || null,
    };
  }

  get(id) {
    return this.agents.get(id) || null;
  }

  list() {
    return [...this.agents.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** 对外快照。字段名保持向后兼容（sessionId 仍在）。 */
  snapshot(extra) {
    return Object.assign(
      {
        serverTime: Date.now(),
        startedAt: this.startedAt,
        seq: this.store.seq,
        sources: [...this.adapters.keys()],
        sessions: this.list(),
      },
      extra || {}
    );
  }
}
