import { randomUUID } from "node:crypto";

/**
 * Pi 控制通道。
 *
 * 用户自己开的 Pi 没有外部控制 socket，只能由 Pi 进程内的扩展主动连 host。
 * 这里保存扩展注册的会话、下发指令队列，并给 /api/prompt、/api/cancel 提供落点。
 *
 * 只做控制，不做审批：不会拦工具，也不会因为离线而阻断 Pi。
 */
export class PiControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PiControlError";
    this.code = code;
  }
}

export class PiControl {
  constructor(options) {
    const opts = options || {};
    this.hub = opts.hub || null;
    this.log = opts.log || (() => {});
    this.sessionTtlMs = Number(opts.sessionTtlMs) > 0 ? Number(opts.sessionTtlMs) : 60000;
    this.pollTimeoutMs = Number(opts.pollTimeoutMs) > 0 ? Number(opts.pollTimeoutMs) : 25000;
    this.sessions = new Map();
    this.onChange = typeof opts.onChange === "function" ? opts.onChange : null;
  }

  /** hub 里的 id 带 pi: 前缀；扩展上报的是 Pi 原始 id。 */
  canonical(sessionId) {
    const raw = String(sessionId || "");
    if (!raw) return "";
    return raw.startsWith("pi:") ? raw : "pi:" + raw;
  }

  rawId(sessionId) {
    const id = this.canonical(sessionId);
    return id.startsWith("pi:") ? id.slice(3) : id;
  }

  state(sessionId) {
    return this.sessions.get(this.canonical(sessionId)) || null;
  }

  isOnline(sessionId) {
    const state = this.state(sessionId);
    if (!state) return false;
    return Date.now() - state.lastSeen <= this.sessionTtlMs;
  }

  touch(sessionId) {
    const state = this.state(sessionId);
    if (state) state.lastSeen = Date.now();
    return state;
  }

  changed(sessionId) {
    if (!this.onChange) return;
    try {
      this.onChange(this.canonical(sessionId));
    } catch (error) {
      this.log.debug("Pi 控制能力变更通知失败: " + error.message);
    }
  }

  /** 扩展在 session_start（以及 host 重连后）调用。 */
  register(payload) {
    const body = payload || {};
    const id = this.canonical(body.sessionId);
    if (!id || id === "pi:") throw new PiControlError("E_USAGE", "缺少 sessionId");
    const previous = this.sessions.get(id);
    const state = {
      id,
      sessionId: this.rawId(id),
      sessionFile: String(body.sessionFile || (previous && previous.sessionFile) || ""),
      cwd: String(body.cwd || (previous && previous.cwd) || ""),
      pid: Number(body.pid) || (previous && previous.pid) || null,
      lastSeen: Date.now(),
      queue: (previous && previous.queue) || [],
      waiters: (previous && previous.waiters) || [],
    };
    this.sessions.set(id, state);
    if (!previous) this.log.info("Pi 控制扩展已注册: " + id);
    this.changed(id);
    return this.status(id);
  }

  /** 扩展轮询指令；没有指令时挂起，最多 waitMs。 */
  poll(sessionId, waitMs) {
    const id = this.canonical(sessionId);
    const state = this.state(id);
    if (!state) throw new PiControlError("E_NOT_FOUND", "Pi 会话未注册控制通道");
    state.lastSeen = Date.now();

    if (state.queue.length) {
      const commands = state.queue.splice(0, state.queue.length);
      return Promise.resolve(commands);
    }

    const timeout = Math.max(0, Math.min(Number(waitMs) || this.pollTimeoutMs, this.pollTimeoutMs));
    return new Promise((resolve) => {
      const waiter = {
        finish: (commands) => {
          state.waiters = state.waiters.filter((item) => item !== waiter);
          if (timer) clearTimeout(timer);
          resolve(commands);
        },
      };
      const timer = setTimeout(() => waiter.finish([]), timeout);
      state.waiters.push(waiter);
    });
  }

  enqueue(sessionId, command) {
    const id = this.canonical(sessionId);
    const state = this.state(id);
    if (!state || !this.isOnline(id)) throw new PiControlError("E_OFFLINE", "Pi 控制通道不在线");
    state.lastSeen = Date.now();
    const item = Object.assign({ id: randomUUID(), at: Date.now() }, command);
    const waiter = state.waiters.shift();
    if (waiter) waiter.finish([item]);
    else state.queue.push(item);
    return item;
  }

  prompt(sessionId, text, mode) {
    const body = String(text == null ? "" : text);
    if (!body.trim()) throw new PiControlError("E_USAGE", "指令不能为空");
    const item = this.enqueue(sessionId, {
      type: "prompt",
      text: body,
      deliverAs: mode === "steer" || mode === "followUp" ? mode : undefined,
    });
    this.log.info("已向 Pi 会话 " + this.canonical(sessionId) + " 排队指令 " + item.id);
    return { queued: true, id: item.id };
  }

  cancel(sessionId) {
    const id = this.canonical(sessionId);
    const state = this.state(id);
    if (!state || !this.isOnline(id)) throw new PiControlError("E_OFFLINE", "Pi 控制通道不在线");
    // 中断优先：丢掉还没下发的指令，避免 abort 之后又被旧 prompt 起一轮。
    state.queue = state.queue.filter((command) => command.type !== "prompt");
    const item = this.enqueue(id, { type: "abort" });
    this.log.info("已向 Pi 会话 " + id + " 排队中断 " + item.id);
    return { queued: true, id: item.id };
  }

  ack(sessionId, payload) {
    const state = this.touch(sessionId);
    if (!state) throw new PiControlError("E_NOT_FOUND", "Pi 会话未注册控制通道");
    return { ok: true, id: payload && payload.id ? String(payload.id) : null };
  }

  event(sessionId, payload) {
    const id = this.canonical(sessionId);
    const state = this.touch(id);
    if (!state) return { ok: false };
    if (payload && payload.event === "session_shutdown") {
      state.lastSeen = 0;
      for (const waiter of state.waiters.splice(0, state.waiters.length)) waiter.finish([]);
      this.log.info("Pi 控制扩展已断开: " + id);
      this.changed(id);
    }
    return { ok: true };
  }

  status(sessionId) {
    const state = this.state(sessionId);
    if (!state) return { online: false, sessionId: this.canonical(sessionId) };
    return {
      online: this.isOnline(state.id),
      sessionId: state.id,
      sessionFile: state.sessionFile,
      cwd: state.cwd,
      pid: state.pid,
      pending: state.queue.length,
      lastSeen: state.lastSeen,
    };
  }

  /** 测试/诊断用：清掉过期或断开的会话。 */
  prune(now) {
    const at = Number(now) || Date.now();
    for (const [id, state] of [...this.sessions]) {
      if (at - state.lastSeen <= this.sessionTtlMs) continue;
      for (const waiter of state.waiters.splice(0, state.waiters.length)) waiter.finish([]);
      this.sessions.delete(id);
    }
  }
}

export function createPiControl(options) {
  return new PiControl(options);
}
