import { EventStore } from "./store.mjs";
import { EVENT, canonicalEventType, isKnownEventType } from "./contract.mjs";
import { IDLE } from "./status.mjs";

/**
 * 统一状态中枢：所有 adapter 把原始信号翻译成规范事件后交给 Hub。
 * Hub 负责：
 *  - 把旧事件名归一化成规范名（迁移期）
 *  - 去重、排序、缓存（供断线重放）
 *  - 维护会话状态快照
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

  /** 发出一条事件：先归一化类型，再入缓冲，再更新内存状态。 */
  emit(type, payload) {
    const data = payload || {};
    const canonical = canonicalEventType(type);
    if (!canonical && !isKnownEventType(type)) {
      this.log.warn("未知事件类型，已按原样记录: " + type);
    }
    const storedType = canonical || type;
    const event = this.store.push(storedType, data);
    this.applyEvent(storedType, data);
    return event;
  }

  applyEvent(type, data) {
    switch (type) {
      case EVENT.SESSION_UPSERT: {
        const agent = this.normalize(data);
        this.agents.set(agent.id, agent);
        return;
      }
      case EVENT.SESSION_REMOVED: {
        const id = data.id || data.sessionId;
        if (id) this.agents.delete(id);
        return;
      }
      case EVENT.RUN_COMPLETED:
      case EVENT.RUN_FAILED:
      case EVENT.RUN_CANCELED:
      case EVENT.RUN_STARTED: {
        const id = data.sessionId || data.id;
        const agent = id ? this.agents.get(id) : null;
        if (!agent) return;
        agent.runId = data.runId || agent.runId || null;
        if (type === EVENT.RUN_STARTED) {
          agent.lastRun = null;
        } else {
          agent.lastRun = {
            runId: data.runId || null,
            outcome:
              type === EVENT.RUN_COMPLETED ? "completed" : type === EVENT.RUN_FAILED ? "failed" : "canceled",
            text: data.text || "",
            finishedAt: data.finishedAt || Date.now(),
          };
        }
        this.agents.set(id, agent);
        return;
      }
      default:
        return;
    }
  }

  /** 把各 adapter 的不同字段名归一成一份记录。 */
  normalize(payload) {
    const id = payload.id || payload.sessionId || payload.agentId;
    const previous = id ? this.agents.get(id) : null;
    return {
      id,
      sessionId: id,
      parentId: payload.parentId || null,
      blank: !!payload.blank,
      agent: payload.agent || payload.source || "unknown",
      agentLabel: payload.agentLabel || (previous && previous.agentLabel) || payload.agent || payload.source || "unknown",
      capabilities: payload.capabilities || (previous && previous.capabilities) || null,
      title: payload.title || id,
      cwd: payload.cwd || "",
      status: payload.status || IDLE,
      running: !!payload.running,
      runId: payload.runId || (previous && previous.runId) || null,
      lastRun: payload.lastRun || (previous && previous.lastRun) || null,
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
