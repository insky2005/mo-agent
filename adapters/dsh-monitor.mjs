import { TASK, IDLE } from "../core/status.mjs";

const STATUS = {
  RUNNING: TASK.WORKING,
  WAITING: TASK.INPUT_REQUIRED,
  IDLE: IDLE,
  ERROR: TASK.FAILED,
};

function preview(text, max) {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const limit = max || 160;
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

function pickTurnOutline(values) {
  const outline = values && values.turnOutline;
  if (!Array.isArray(outline)) return [];
  return outline.map((turn) => ({
    turn: turn.turn,
    seq: turn.seq,
    prompt: preview(turn.prompt, 300),
    response: preview(turn.response, 600),
  }));
}

/**
 * 监听 DSH 中各个 Agent/Session 的运行状态，推导状态并产出可推送事件。
 */
export class AgentMonitor {
  constructor(options) {
    const opts = options || {};
    this.dsh = opts.dsh;
    this.log = opts.log || (() => {});
    this.pollMs = opts.pollMs || 1500;
    this.activeWindowMs = opts.activeWindowMs || 6 * 3600 * 1000;
    this.maxSessions = opts.maxSessions || 40;
    this.hub = opts.hub; this.store = opts.hub.store;
    this.sessions = new Map();
    this.pending = new Map();
    // 实时状态显示「这一轮跑完了」，等下次轮询拿到最新回复再发完成通知
    this.awaitingCompletion = new Set();
    // 已经为哪个轮次发过完成通知，避免重复
    this.lastNotifiedTurns = new Map();
    this.knownAgentIds = new Map();
    this.timer = null;
    this.polling = false;
    this.lastError = null;
    this.startedAt = Date.now();
    this.dsh.on("event", (frame) => this.onRemoteEvent(frame));
    this.dsh.on("waterfall", (frame) => this.onWaterfall(frame));
    this.dsh.on("cancel", (eventId) => this.onPendingCancelled(eventId));
  }

  start() {
    this.schedule(0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    if (this.polling) return;
    this.polling = true;
    try {
      const value = await this.dsh.listSessions();
      this.lastError = null;
      this.applyList(value && value.items ? value.items : []);
    } catch (error) {
      if (this.lastError !== error.message) {
        this.lastError = error.message;
        this.log.warn("拉取会话列表失败: " + error.message);
        this.hub.emit("dsh.error", { message: error.message });
      }
    } finally {
      this.polling = false;
      this.schedule(this.pollMs);
    }
  }

  applyList(items) {
    // DSH 会返回全部历史会话；只保留“活跃”的：正在运行、有待处理询问、
    // 或最近一段时间内有更新，避免把几百条历史会话推给手机。
    const now = Date.now();
    const relevant = items
      .filter((item) => {
        if (item.running) return true;
        if (this.pendingForSession(item.sessionId).length > 0) return true;
        return now - (item.updatedAt || 0) < this.activeWindowMs;
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, this.maxSessions);
    const seen = new Set();
    for (const item of relevant) {
      seen.add(item.sessionId);
      this.applySession(item);
    }
    for (const [id, session] of [...this.sessions]) {
      if (seen.has(id)) continue;
      this.sessions.delete(id);
      this.awaitingCompletion.delete(id);
      this.lastNotifiedTurns.delete(id);
      this.hub.emit("session.removed", { sessionId: id });
    }
  }

  applySession(item) {
    const prev = this.sessions.get(item.sessionId) || null;
    const values = (item.projections && item.projections.values) || {};
    const outline = pickTurnOutline(values);
    const lastTurn = outline.length ? outline[outline.length - 1] : null;
    const pendingList = this.pendingForSession(item.sessionId);
    let status = STATUS.IDLE;
    if (item.running) status = STATUS.RUNNING;
    else if (pendingList.length > 0) status = STATUS.WAITING;
    else if (prev && prev.status === STATUS.ERROR && !item.running) status = STATUS.ERROR;

    const session = {
      agent: "dsh",
      sessionId: item.sessionId,
      parentId: item.parentSessionId || null,
      blank: !!item.blank,
      title: values.title || (item.cwd ? item.cwd.split("/").pop() : item.sessionId),
      cwd: item.cwd || "",
      running: !!item.running,
      agentAvailable: !!item.agentAvailable,
      status,
      updatedAt: item.updatedAt || 0,
      turnOutline: outline,
      lastPrompt: lastTurn ? lastTurn.prompt : "",
      lastResponse: lastTurn ? lastTurn.response : "",
      turns: (values.sessionStats && values.sessionStats.turns) || outline.length,
      steps: (values.sessionStats && values.sessionStats.steps) || 0,
      tokenUsage: values.tokenUsage || null,
      todos: values.todos || null,
      plan: values.plan || null,
      subagent: values.subagent || null,
      pending: pendingList.map((p) => ({ eventId: p.eventId, kind: p.kind })),
    };
    this.sessions.set(session.sessionId, session);

    const changed = !prev || prev.status !== session.status || prev.updatedAt !== session.updatedAt || !prev.lastResponse && session.lastResponse;
    if (changed) {
      this.hub.emit("session.upsert", session);
    }
    // 完成判定：以「轮次增加」为主（不依赖轮询是否恰好抓到 running），
    // 再兼顾实时 status 报的结束与状态跃迁。三个信号合并，保证每轮只通知一次。
    if (!prev) this.lastNotifiedTurns.set(session.sessionId, session.turns || 0);
    const knownTurns = this.lastNotifiedTurns.get(session.sessionId) || 0;
    const turned = (session.turns || 0) > knownTurns;
    const awaiting = this.awaitingCompletion.has(session.sessionId) && !session.running;
    if (awaiting) this.awaitingCompletion.delete(session.sessionId);
    const stopped = prev && prev.status === STATUS.RUNNING && session.status === STATUS.IDLE;
    if (!session.running && (turned || awaiting || stopped)) {
      this.lastNotifiedTurns.set(session.sessionId, session.turns || 0);
      this.notice("completed", session, "任务完成", session.lastResponse || "Agent 已结束本轮工作");
    }
    if (prev && !prev.running && session.running) {
      this.hub.emit("session.started", { sessionId: session.sessionId, title: session.title });
    }
    if (prev && prev.status !== STATUS.ERROR && session.status === STATUS.ERROR) {
      this.notice("error", session, "Agent 出错", session.lastResponse || "Agent 运行失败");
    }
  }

  pendingForSession(sessionId) {
    return [...this.pending.values()].filter((p) => p.sessionId === sessionId);
  }

  guessSessionId(agentId) {
    if (!agentId || typeof agentId !== "string") return null;
    if (this.sessions.has(agentId)) return agentId;
    const match = agentId.match(/session-[0-9a-fA-F-]{36}/);
    if (match && this.sessions.has(match[0])) return match[0];
    return match ? match[0] : null;
  }

  onWaterfall(frame) {
    const event = frame && frame.event;
    const request = (frame && frame.request) || {};
    if (event === "user-questions/request") {
      this.addPending({
        eventId: frame.eventId,
        kind: "question",
        sessionId: this.guessSessionId(frame.agentId),
        agentId: frame.agentId,
        question: {
          questions: request.questions || [],
        },
      });
      return;
    }
    if (event === "approval/request") {
      this.addPending({
        eventId: frame.eventId,
        kind: "approval",
        sessionId: this.guessSessionId(frame.agentId),
        agentId: frame.agentId,
        question: {
          toolName: request.toolName || "",
          reason: request.reason || (request.displayReason && request.displayReason.zh) || "",
        },
      });
    }
  }

  addPending(item) {
    if (!item.sessionId) {
      // 无法定位会话时，暂记到当前正在运行的会话，保证手机上仍可处理。
      const running = [...this.sessions.values()].filter((s) => s.running);
      if (running.length === 1) item.sessionId = running[0].sessionId;
    }
    this.pending.set(item.eventId, item);
    const session = item.sessionId ? this.sessions.get(item.sessionId) : null;
    this.hub.emit("pending.added", {
      eventId: item.eventId,
      kind: item.kind,
      sessionId: item.sessionId,
      sessionTitle: session ? session.title : "",
      question: item.question,
    });
    if (session) {
      session.status = STATUS.WAITING;
      session.pending = this.pendingForSession(session.sessionId).map((p) => ({ eventId: p.eventId, kind: p.kind }));
      this.hub.emit("session.upsert", session);
    }
  }

  describePending(item) {
    if (item.kind === "approval") {
      return (item.question.reason || item.question.toolName || "需要你的授权") + "";
    }
    const questions = item.question.questions || [];
    if (!questions.length) return "Agent 需要你的输入";
    return questions.map((q) => q.question).join(" / ");
  }

  onPendingCancelled(eventId) {
    this.resolvePending(eventId, "cancelled");
  }

  resolvePending(eventId, reason) {
    const item = this.pending.get(eventId);
    if (!item) return false;
    this.pending.delete(eventId);
    this.hub.emit("pending.resolved", { eventId, reason: reason || "answered" });
    if (item.sessionId) {
      const session = this.sessions.get(item.sessionId);
      if (session) {
        session.pending = this.pendingForSession(item.sessionId).map((p) => ({ eventId: p.eventId, kind: p.kind }));
        if (!session.running && session.pending.length === 0) session.status = STATUS.IDLE;
        this.hub.emit("session.upsert", session);
      }
    }
    return true;
  }

  onRemoteEvent(frame) {
    const event = frame && frame.event;
    if (event === "api-session/status") {
      const args = frame.args || [];
      const sessionId = args[0];
      const running = !!args[1];
      const session = this.sessions.get(sessionId);
      if (session && session.running !== running) {
        const wasRunning = session.running;
        session.running = running;
        if (running) {
          session.status = STATUS.RUNNING;
        } else {
          session.status = this.pendingForSession(sessionId).length > 0 ? STATUS.WAITING : STATUS.IDLE;
          // 实时通道才是权威信号：一轮结束在这里就能知道。
          // 只靠轮询的状态跃迁会漏掉「两次轮询之间就跑完」的快轮次。
          if (wasRunning) this.awaitingCompletion.add(sessionId);
        }
        this.hub.emit("session.upsert", session);
      }
      return;
    }
    if (event === "api-session/error") {
      const args = frame.args || [];
      const sessionId = args[0];
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = STATUS.ERROR;
        this.hub.emit("session.upsert", session);
      }
      this.notice("error", session || null, "Agent 出错", String(args[1] || "运行失败"));
      return;
    }
  }

  notice(kind, session, title, body) {
    this.hub.emit("notice", {
      kind,
      title,
      body: preview(body, 400),
      sessionId: session ? session.sessionId : null,
      sessionTitle: session ? session.title : "",
    });
  }

  snapshot() {
    return {
      serverTime: Date.now(),
      startedAt: this.startedAt,
      seq: this.store.seq,
      pollMs: this.pollMs,
      lastError: this.lastError,
      sessions: [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      pending: [...this.pending.values()].map((p) => ({
        eventId: p.eventId,
        kind: p.kind,
        sessionId: p.sessionId,
        question: p.question,
      })),
    };
  }
}

export { STATUS };
