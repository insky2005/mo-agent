import { TASK, IDLE } from "../core/status.mjs";
import { EVENT, makeRunId, hasResponseText, TERMINAL_STATUSES } from "../core/contract.mjs";

const STATUS = {
  RUNNING: TASK.WORKING,
  WAITING: TASK.INPUT_REQUIRED,
  AUTH: TASK.AUTH_REQUIRED,
  IDLE: IDLE,
  ERROR: TASK.FAILED,
};

function preview(text, max) {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const limit = max || 160;
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

/** 保留换行/缩进的截断，供详情层显示。 */
function truncateText(text, max) {
  const value = String(text == null ? "" : text).trim();
  const limit = max || 4000;
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

function assistantText(message) {
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const parts = message.content
      .filter((p) => p && typeof p.text === "string" && p.type !== "reasoning" && p.type !== "tool-call")
      .map((p) => p.text);
    return parts.join("\n");
  }
  return "";
}

/** session/page 的 records 里取最后一条可见的 assistant 文本。 */
function lastAssistantText(page) {
  const records = page && Array.isArray(page.records) ? page.records : [];
  let last = "";
  for (const record of records) {
    const event = record && record.event;
    if (!event || (event.type !== "assistant/message" && event.type !== "message")) continue;
    const message = event.data && event.data.message ? event.data.message : event.data;
    const text = assistantText(message);
    if (text) last = text;
  }
  return last;
}

/** DSH session/page 的 user/message 里的可见文本。 */
function userMessageText(data) {
  if (!data) return "";
  if (typeof data.content === "string") return data.content;
  if (Array.isArray(data.content)) {
    return data.content
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/** 把 session/page 的 records 归并成按轮次排列的历史。 */
function parseDshHistory(page) {
  const map = new Map();
  const records = page && Array.isArray(page.records) ? page.records : [];
  for (const record of records) {
    const event = record && record.event;
    if (!event) continue;
    const data = event.data || {};
    const turn = Number(data.turn);
    if (!Number.isFinite(turn)) continue;
    if (event.type === "user/message") {
      const prompt = userMessageText(data);
      if (!prompt) continue;
      const item = map.get(turn) || { turn, prompt: "", response: "" };
      item.prompt = prompt;
      map.set(turn, item);
    } else if (event.type === "assistant/message") {
      const response = assistantText(data.message || data);
      if (!response) continue;
      const item = map.get(turn) || { turn, prompt: "", response: "" };
      item.response = truncateText(response, 12000);
      map.set(turn, item);
    }
  }
  return [...map.values()]
    .sort((a, b) => a.turn - b.turn)
    .filter((item) => item.prompt || item.response);
}

function pickTurnOutline(values) {
  const outline = values && values.turnOutline;
  if (!Array.isArray(outline)) return [];
  return outline.map((turn) => ({
    turn: turn.turn,
    seq: turn.seq,
    prompt: truncateText(turn.prompt, 2000),
    response: truncateText(turn.response, 12000),
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
    this.profile = opts.profile || {};
    // runEnd: explicit | inferred | none；none 时只更新状态，不发完成信号。
    this.runEnd = (this.profile.capabilities && this.profile.capabilities.runEnd) || "inferred";
    this.sessions = new Map();
    this.pending = new Map();
    // 实时状态显示「这一轮跑完了」，等下次轮询拿到最新回复再发完成通知
    this.awaitingCompletion = new Set();
    // 当前正在跑的一轮：sessionId -> runId；同一轮开始/结束用同一个 runId 去重
    this.activeRuns = new Map();
    this.runSeq = new Map();
    this.enriched = new Set();
    // 历史已完成会话只补全最近几条，避免启动时对几十个会话同时翻日志。
    this.enrichBudget = 5;
    // 上一次看到的轮次数，用于识别「两次轮询之间就跑完」的快轮次
    this.lastKnownTurns = new Map();
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
        this.hub.emit(EVENT.DSH_ERROR, { message: error.message });
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
      this.activeRuns.delete(id);
      this.runSeq.delete(id);
      this.enriched.delete(id);
      this.lastKnownTurns.delete(id);
      this.hub.emit(EVENT.SESSION_REMOVED, { sessionId: id });
    }
  }

  applySession(item) {
    const prev = this.sessions.get(item.sessionId) || null;
    const firstScan = !prev;
    const values = (item.projections && item.projections.values) || {};
    const outline = pickTurnOutline(values);
    const lastTurn = outline.length ? outline[outline.length - 1] : null;
    const pendingList = this.pendingForSession(item.sessionId);
    const pendingStatus = this.pendingStatus(item.sessionId);
    const turns = (values.sessionStats && values.sessionStats.turns) || outline.length;
    const hasResponse = !!(lastTurn && hasResponseText(lastTurn.response));

    // 运行轮次跟踪：开始/结束都在源头标记，通知不再靠状态 diff 推断。
    let runStartedId = null;
    let runEndedId = null;
    if (firstScan) {
      this.lastKnownTurns.set(item.sessionId, turns);
      if (item.running) this.activeRuns.set(item.sessionId, this.nextRunId(item.sessionId));
      else this.activeRuns.delete(item.sessionId);
    } else {
      const wasRunning = !!prev.running;
      if (item.running) {
        if (!wasRunning) {
          runStartedId = this.nextRunId(item.sessionId);
          this.activeRuns.set(item.sessionId, runStartedId);
        }
      } else {
        const awaiting = this.awaitingCompletion.has(item.sessionId);
        if (awaiting) this.awaitingCompletion.delete(item.sessionId);
        if (wasRunning || awaiting) {
          if (pendingStatus) {
            // 本轮卡在提问/授权上：先保留 activeRun，等 resolvePending 再补完成信号。
          } else {
            runEndedId = this.activeRuns.get(item.sessionId) || this.nextRunId(item.sessionId);
            this.activeRuns.delete(item.sessionId);
          }
        } else if (!pendingStatus && turns > (this.lastKnownTurns.get(item.sessionId) || 0)) {
          // 两次轮询之间就跑完的快轮次：轮次推进本身就是完成信号。
          runEndedId = this.nextRunId(item.sessionId);
        }
      }
      this.lastKnownTurns.set(item.sessionId, turns);
    }

    let status;
    if (item.running) status = STATUS.RUNNING;
    else if (pendingStatus) status = pendingStatus;
    else if (prev && prev.status === STATUS.ERROR) status = STATUS.ERROR;
    else if (prev && prev.status === TASK.COMPLETED) status = TASK.COMPLETED;
    else if (prev && TERMINAL_STATUSES.has(prev.status) && prev.status !== TASK.COMPLETED) status = prev.status;
    else if (runEndedId || hasResponse) status = TASK.COMPLETED;
    else status = STATUS.IDLE;

    // 实时通道先报结束、轮询还没拿到回复时，状态也应该是 completed，而不是 idle。
    if (runEndedId && !pendingStatus && status !== STATUS.ERROR) status = TASK.COMPLETED;

    const session = {
      agent: "dsh",
      agentLabel: (this.profile && this.profile.label) || "DeepSeek Harness",
      capabilities: this.profile.capabilities || null,
      sessionId: item.sessionId,
      parentId: item.parentSessionId || null,
      blank: !!item.blank,
      title: values.title || (item.cwd ? item.cwd.split("/").pop() : item.sessionId),
      cwd: item.cwd || "",
      running: !!item.running,
      agentAvailable: !!item.agentAvailable,
      status,
      runId: this.activeRuns.get(item.sessionId) || runEndedId || (prev && prev.runId) || null,
      asOfSeq: (item.projections && item.projections.asOfSeq) || null,
      updatedAt: item.updatedAt || 0,
      turnOutline: outline,
      lastPrompt: lastTurn ? lastTurn.prompt : "",
      lastResponse: lastTurn ? lastTurn.response : "",
      turns,
      steps: (values.sessionStats && values.sessionStats.steps) || 0,
      tokenUsage: values.tokenUsage || null,
      todos: values.todos || null,
      plan: values.plan || null,
      subagent: values.subagent || null,
      pending: pendingList.map((p) => ({ eventId: p.eventId, kind: p.kind })),
    };
    this.sessions.set(session.sessionId, session);

    const changed =
      !prev ||
      prev.status !== session.status ||
      prev.updatedAt !== session.updatedAt ||
      prev.running !== session.running ||
      (!prev.lastResponse && session.lastResponse);
    if (changed) this.hub.emit(EVENT.SESSION_UPSERT, session);

    if (runStartedId && this.runEnd !== "none") {
      this.hub.emit(EVENT.RUN_STARTED, {
        runId: runStartedId,
        sessionId: session.sessionId,
        agent: "dsh",
        agentLabel: session.agentLabel,
        title: session.title,
        sessionTitle: session.title,
        startedAt: Date.now(),
      });
    }
    if (runEndedId && !pendingStatus && status !== STATUS.ERROR && this.runEnd !== "none") {
      this.finishRun(session, runEndedId, session.lastResponse || "Agent 已结束本轮工作");
    } else if (firstScan && !item.running && hasResponse) {
      // 历史已完成会话：只补全详情，不发完成通知。
      this.enrichSession(session);
    }
  }

  /** 首次扫描到已完成会话时，用 session/page 把 120 字预览换成完整回复。 */
  async enrichSession(session) {
    if (!this.dsh || typeof this.dsh.pageSession !== "function" || typeof session.asOfSeq !== "number") return;
    if (this.enrichBudget <= 0) return;
    this.enrichBudget -= 1;
    const key = session.sessionId + ":" + session.asOfSeq;
    if (this.enriched.has(key)) return;
    this.enriched.add(key);
    if (this.enriched.size > 1000) this.enriched.clear();
    try {
      const page = await this.dsh.pageSession(session.sessionId, session.asOfSeq, 400);
      const full = truncateText(lastAssistantText(page), 12000);
      if (!full) return;
      const current = this.sessions.get(session.sessionId);
      if (current !== session || full === session.lastResponse) return;
      session.lastResponse = full;
      this.hub.emit(EVENT.SESSION_UPSERT, session);
    } catch (error) {
      /* 补全失败保留预览，不影响状态 */
    }
  }

  /**
   * turnOutline 里的 response 是 120 字预览；完成时用 session/page 补全完整回复，
   * 先更新 session.upsert（详情层），再发 run.completed（通知）。
   */
  async finishRun(session, runId, fallback) {
    const emit = (text) => {
      this.hub.emit(EVENT.RUN_COMPLETED, {
        runId,
        sessionId: session.sessionId,
        agent: "dsh",
        agentLabel: session.agentLabel,
        title: session.title,
        sessionTitle: session.title,
        text,
        finishedAt: Date.now(),
      });
    };
    const canPage = this.dsh
      && typeof this.dsh.pageSession === "function"
      && typeof session.asOfSeq === "number";
    if (!canPage) {
      emit(fallback);
      return;
    }

    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("session/page timeout")), 2500);
    });
    try {
      const page = await Promise.race([
        this.dsh.pageSession(session.sessionId, session.asOfSeq, 400),
        timeout,
      ]);
      const full = truncateText(lastAssistantText(page), 12000);
      const text = full || fallback;
      const current = this.sessions.get(session.sessionId);
      if (current === session && session.status === TASK.COMPLETED) {
        session.lastResponse = text;
        this.hub.emit(EVENT.SESSION_UPSERT, session);
      }
      emit(text);
    } catch (error) {
      emit(fallback);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 按需读取会话历史（最近 limit 轮），供手机详情层展示。 */
  async history(sessionId, options) {
    const session = this.sessions.get(sessionId);
    const limit = Math.min(50, Math.max(1, Number(options && options.limit) || 20));
    if (!session || typeof session.asOfSeq !== "number" || !this.dsh || typeof this.dsh.pageSession !== "function") {
      return { turns: [], truncated: false, total: 0 };
    }
    const page = await this.dsh.pageSession(sessionId, session.asOfSeq, 2000);
    const all = parseDshHistory(page);
    // session/page 可能缺整轮（远程/附件/中途中断），turnOutline 是轮次的完整索引：
    // 先补齐缺失轮次，再用它的 prompt 给没有 user/message 的轮次兜底。
    const outline = new Map((session.turnOutline || []).map((item) => [Number(item.turn), item]));
    const seenTurns = new Set(all.map((item) => item.turn));
    for (const extra of session.turnOutline || []) {
      const turn = Number(extra.turn);
      if (!Number.isFinite(turn) || seenTurns.has(turn)) continue;
      all.push({ turn, prompt: extra.prompt || "", response: extra.response || "" });
      seenTurns.add(turn);
    }
    all.sort((a, b) => a.turn - b.turn);
    for (const item of all) {
      const extra = outline.get(item.turn);
      if (!item.prompt && extra && extra.prompt) item.prompt = extra.prompt;
      if (!item.response && extra && extra.response) item.response = extra.response;
    }
    return {
      turns: all.slice(-limit),
      truncated: all.length > limit,
      total: all.length,
    };
  }

  nextRunId(sessionId) {
    const seq = (this.runSeq.get(sessionId) || 0) + 1;
    this.runSeq.set(sessionId, seq);
    return makeRunId(sessionId, seq);
  }

  pendingStatus(sessionId) {
    const list = this.pendingForSession(sessionId);
    if (!list.length) return null;
    return list.some((p) => p.kind === "approval") ? STATUS.AUTH : STATUS.WAITING;
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
    this.hub.emit(EVENT.PENDING_ADDED, {
      eventId: item.eventId,
      kind: item.kind,
      sessionId: item.sessionId,
      sessionTitle: session ? session.title : "",
      agent: "dsh",
      agentLabel: session ? session.agentLabel : "DeepSeek Harness",
      question: item.question,
    });
    if (session) {
      session.status = item.kind === "approval" ? STATUS.AUTH : STATUS.WAITING;
      session.pending = this.pendingForSession(session.sessionId).map((p) => ({ eventId: p.eventId, kind: p.kind }));
      this.hub.emit(EVENT.SESSION_UPSERT, session);
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
    this.hub.emit(EVENT.PENDING_RESOLVED, { eventId, reason: reason || "answered" });
    if (item.sessionId) {
      const session = this.sessions.get(item.sessionId);
      if (session) {
        session.pending = this.pendingForSession(item.sessionId).map((p) => ({ eventId: p.eventId, kind: p.kind }));
        if (!session.running && session.pending.length === 0) {
          const runId = this.activeRuns.get(item.sessionId);
          if (runId) {
            // 本轮是在等待回答/授权时结束的：待办清空后再补完成信号。
            this.activeRuns.delete(item.sessionId);
            session.status = TASK.COMPLETED;
            session.runId = runId;
            this.hub.emit(EVENT.SESSION_UPSERT, session);
            if (this.runEnd !== "none") {
              this.finishRun(session, runId, session.lastResponse || "Agent 已结束本轮工作");
            }
            return true;
          }
          session.status = hasResponseText(session.lastResponse) ? TASK.COMPLETED : STATUS.IDLE;
        }
        this.hub.emit(EVENT.SESSION_UPSERT, session);
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
        let runStartedId = null;
        if (running) {
          session.status = STATUS.RUNNING;
          if (!this.activeRuns.has(sessionId)) {
            runStartedId = this.nextRunId(sessionId);
            this.activeRuns.set(sessionId, runStartedId);
          }
          session.runId = this.activeRuns.get(sessionId);
        } else {
          const pendingStatus = this.pendingStatus(sessionId);
          // 实时通道只告诉我们「停了」；先按 completed 显示，等轮询拿最新回复再发完成信号。
          session.status = pendingStatus || TASK.COMPLETED;
          if (wasRunning && !pendingStatus) this.awaitingCompletion.add(sessionId);
          session.runId = this.activeRuns.get(sessionId) || session.runId || null;
        }
        this.hub.emit(EVENT.SESSION_UPSERT, session);
        if (runStartedId && this.runEnd !== "none") {
          this.hub.emit(EVENT.RUN_STARTED, {
            runId: runStartedId,
            sessionId: session.sessionId,
            agent: "dsh",
            agentLabel: session.agentLabel,
            title: session.title,
            sessionTitle: session.title,
            startedAt: Date.now(),
          });
        }
      }
      return;
    }
    if (event === "api-session/error") {
      const args = frame.args || [];
      const sessionId = args[0];
      const session = this.sessions.get(sessionId);
      if (!session) return;
      const runId = this.activeRuns.get(sessionId) || this.nextRunId(sessionId);
      this.activeRuns.delete(sessionId);
      this.awaitingCompletion.delete(sessionId);
      session.running = false;
      session.status = STATUS.ERROR;
      session.runId = runId;
      this.hub.emit(EVENT.SESSION_UPSERT, session);
      if (this.runEnd !== "none") {
        this.hub.emit(EVENT.RUN_FAILED, {
          runId,
          sessionId: session.sessionId,
          agent: "dsh",
          agentLabel: session.agentLabel,
          title: session.title,
          sessionTitle: session.title,
          text: String(args[1] || "运行失败"),
          finishedAt: Date.now(),
        });
      }
      return;
    }
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
