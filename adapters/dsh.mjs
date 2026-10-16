import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

let WebSocketImpl = null;
async function loadWebSocket() {
  if (WebSocketImpl) return WebSocketImpl;
  try {
    const mod = await import("ws");
    WebSocketImpl = mod.default || mod;
  } catch (error) {
    const hint = [
      "缺少依赖 ws。请在 mo-agent 目录执行：",
      "  npm install ws --cache /tmp/npmcache",
      "（若 npm 缓存目录权限异常，可加 --cache 指向一个可写目录）",
    ].join("\n");
    const wrapped = new Error(hint);
    wrapped.cause = error;
    throw wrapped;
  }
  return WebSocketImpl;
}

const MUX_PATH = "/api/remote.mux";
const EVENTS_ENDPOINT = "$events";
const EVENTS_RESULT_ENDPOINT = "$events/result";

/** DSH 本地控制面客户端：鉴权、HTTP RPC、WebSocket 事件流、远程事件应答。 */
export class DshClient extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.log = opts.log || (() => {});
    this.home = opts.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    this.baseUrl = opts.baseUrl || null;
    this.token = null;
    this.cookie = null;
    this.mux = null;
    this.streams = new Map();
    this.eventsStreamId = null;
    this.eventsClientId = null;
    this.closed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.connecting = null;
  }

  /** 读取 dsh-web.json 得到端口与启动令牌。 */
  async discover() {
    if (this.baseUrl && this.token) return;
    const file = path.join(this.home, "oh-my-dsh", "shell", "dsh-web.json");
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error("读取 DSH 状态文件失败: " + file + "（请确认 oh-my-dsh 正在运行）");
    }
    if (!this.baseUrl) this.baseUrl = "http://127.0.0.1:" + raw.port;
    if (!this.token) this.token = raw.token;
  }

  /** 用启动令牌换取浏览器会话 Cookie。 */
  async authenticate(force) {
    if (this.cookie && !force) return this.cookie;
    await this.discover();
    const res = await fetch(this.baseUrl + "/?token=" + encodeURIComponent(this.token), { redirect: "manual" });
    let cookie = "";
    if (typeof res.headers.getSetCookie === "function") {
      cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    } else {
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
    }
    if (!cookie) {
      this.cookie = null;
      throw new Error("DSH 鉴权失败：未取得会话 Cookie（启动令牌可能已过期，或 DSH 已重启）");
    }
    this.cookie = cookie;
    return cookie;
  }

  /** 调用一个 Typert Remote 端点，返回业务值。 */
  async rpc(endpoint, args, options) {
    const opts = options || {};
    let cookie = await this.authenticate();
    const body = JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method: endpoint,
      payload: { args: args || {} },
    });
    const doFetch = (ck) =>
      fetch(this.baseUrl + "/api/" + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ck },
        body,
        signal: opts.signal,
      });
    let res = await doFetch(cookie);
    if (res.status === 401) {
      cookie = await this.authenticate(true);
      res = await doFetch(cookie);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error("DSH " + endpoint + " HTTP " + res.status + ": " + text);
    }
    const json = await res.json();
    if (!json || json.type !== "server-response") throw new Error("DSH " + endpoint + " 响应格式异常");
    if (!json.result || json.result.ok !== true) {
      const err = (json.result && json.result.error) || { code: "unknown", message: "unknown" };
      const failure = new Error("DSH " + endpoint + " 失败: " + err.message);
      failure.code = err.code;
      throw failure;
    }
    return json.result.value;
  }

  /** 建立到 DSH 的远程流复用 WebSocket 连接。 */
  async connect() {
    if (this.closed) return;
    if (this.mux && this.mux.readyState === 1) return;
    if (this.connecting) return this.connecting;
    const Ws = await loadWebSocket();
    const task = (async () => {
      await this.authenticate();
      const wsUrl = this.baseUrl.replace(/^http/, "ws") + MUX_PATH;
      this.log.debug("连接 DSH 事件通道 " + wsUrl);
      const ws = new Ws(wsUrl, { headers: { cookie: this.cookie } });
      this.mux = ws;
      ws.on("open", () => {
        this.reconnectAttempt = 0;
        this.log.info("DSH 事件通道已连接");
        this.emit("mux-open");
        this.openEventsStream();
      });
      ws.on("message", (data) => this.onMuxMessage(data));
      ws.on("close", (code, reason) => {
        this.log.warn("DSH 事件通道断开 (" + code + " " + String(reason || "") + ")");
        if (this.mux === ws) this.mux = null;
        this.emit("mux-close");
        this.scheduleReconnect();
      });
      ws.on("error", (error) => {
        this.log.debug("DSH 事件通道错误: " + error.message);
      });
    })();
    this.connecting = task;
    try {
      await task;
    } finally {
      this.connecting = null;
    }
  }

  scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    const base = 500;
    const cap = 10000;
    const delay = Math.min(cap, base * Math.pow(2, Math.min(this.reconnectAttempt, 5)));
    this.reconnectAttempt += 1;
    this.log.debug("将在 " + delay + "ms 后重连 DSH 事件通道");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => this.log.warn("重连 DSH 事件通道失败: " + error.message));
    }, delay);
  }

  send(message) {
    const ws = this.mux;
    if (!ws || ws.readyState !== 1) throw new Error("DSH 事件通道未连接");
    ws.send(JSON.stringify(message));
  }

  /** 打开一条逻辑流。 */
  openStream(endpoint, payload, handlers) {
    const streamId = randomUUID();
    this.streams.set(streamId, handlers || {});
    this.send({ type: "open", streamId, endpoint, payload });
    return {
      streamId,
      cancel: () => {
        this.streams.delete(streamId);
        try {
          this.send({ type: "cancel", streamId });
        } catch (error) {
          /* 通道已关闭，忽略 */
        }
      },
    };
  }

  openEventsStream() {
    if (this.eventsStreamId) return;
    const stream = this.openStream(EVENTS_ENDPOINT, { args: {} }, {
      item: (value) => this.onEventFrame(value),
      end: () => this.onEventsStreamEnded(),
      error: (error) => {
        this.log.warn("远程事件流错误: " + (error && error.message ? error.message : String(error)));
        this.onEventsStreamEnded();
      },
    });
    this.eventsStreamId = stream.streamId;
  }

  onEventsStreamEnded() {
    this.eventsStreamId = null;
    this.eventsClientId = null;
    this.emit("events-closed");
    if (this.mux && this.mux.readyState === 1) {
      // 流被 Host 结束（通常是一次连接generation失败），重连以重新订阅。
      this.log.debug("远程事件流结束，重建 DSH 事件通道");
      try {
        this.mux.close(4000, "events stream ended");
      } catch (error) {
        /* 忽略 */
      }
    }
  }

  onEventFrame(value) {
    if (!value || typeof value !== "object") return;
    if (value.type === "ready") {
      this.eventsClientId = value.clientId;
      this.log.info("远程事件订阅就绪 clientId=" + value.clientId);
      this.emit("ready", value);
      return;
    }
    if (value.type === "emit") {
      this.emit("event", value);
      return;
    }
    if (value.type === "waterfall") {
      this.emit("waterfall", value);
      return;
    }
    if (value.type === "cancel") {
      this.emit("cancel", value.eventId);
    }
  }

  onMuxMessage(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch (error) {
      return;
    }
    const handlers = this.streams.get(frame.streamId);
    if (!handlers) return;
    if (frame.type === "item") {
      if (handlers.item) handlers.item(frame.value);
      return;
    }
    this.streams.delete(frame.streamId);
    if (frame.streamId === this.eventsStreamId) this.eventsStreamId = null;
    if (frame.type === "end") {
      if (handlers.end) handlers.end();
    } else if (frame.type === "error") {
      if (handlers.error) handlers.error(frame.error);
    }
  }

  /** 回复一个 waterfall 远程事件（例如 ask_user_question / approval）。 */
  answer(eventId, outcome) {
    if (!this.eventsClientId) throw new Error("远程事件订阅尚未就绪");
    return this.rpc(EVENTS_RESULT_ENDPOINT, {
      clientId: this.eventsClientId,
      eventId,
      outcome,
    });
  }

  // ------------------------------------------------------------------ 业务封装

  listSessions(signal) {
    return this.rpc("session/list", { _request: {} }, { signal });
  }

  prompt(sessionId, text, mode) {
    return this.rpc("session/prompt", {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: mode === "steer" ? "steer" : "queue",
        content: [{ type: "text", text: String(text) }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  cancel(sessionId) {
    return this.rpc("session/cancel", { request: { sessionId } });
  }

  createSession(cwd, agentPreset) {
    const request = {};
    if (cwd) request.cwd = cwd;
    if (agentPreset) request.agentPreset = agentPreset;
    return this.rpc("session/create", { request });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.mux;
    this.mux = null;
    if (ws) {
      try {
        ws.close(1000, "mo-agent shutdown");
      } catch (error) {
        /* 忽略 */
      }
    }
  }
}
