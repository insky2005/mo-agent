// MO_AGENT_PI_CONTROL implementation
//
// 用户自己开的 Pi 没有外部控制 socket，只能由进程内扩展主动连 Mo host。
// 本扩展只做控制，不注册 tool_call，也不拦截任何工具。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "MO_AGENT_PI_CONTROL";
const SESSION_FILE = path.join(os.homedir(), ".mo-agent", "session.json");
const POLL_WAIT_MS = 25000;
const POLL_TIMEOUT_MS = 30000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let current = null;
let generation = 0;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
}

function loadSession() {
  const envUrl = process.env.MO_AGENT_URL;
  const envToken = process.env.MO_AGENT_TOKEN;
  if (envUrl && envToken) return { url: String(envUrl).replace(/\/$/, ""), token: envToken };
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    if (raw && raw.url && raw.token) return { url: String(raw.url).replace(/\/$/, ""), token: raw.token };
  } catch (error) {
    /* mo-agent 没在跑 */
  }
  return null;
}

async function request(session, pathname, options) {
  const opts = options || {};
  const headers = Object.assign({
    "content-type": "application/json",
    "x-mo-agent-local": session.token,
  }, opts.headers || {});
  const res = await fetch(session.url + pathname, {
    method: opts.method || "GET",
    headers,
    body: opts.body == null ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs || 10000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch (error) {
      /* 忽略 */
    }
    throw new Error("HTTP " + res.status + (detail ? " " + detail.slice(0, 200) : ""));
  }
  return res.json();
}

function sessionInfo(ctx) {
  let sessionId = "";
  let sessionFile = "";
  try {
    if (ctx && ctx.sessionManager) {
      sessionId = ctx.sessionManager.getSessionId() || "";
      sessionFile = ctx.sessionManager.getSessionFile() || "";
    }
  } catch (error) {
    /* 某些模式没有 session manager */
  }
  return { sessionId, sessionFile, cwd: (ctx && ctx.cwd) || "", pid: process.pid };
}

function stopCurrent() {
  if (current) current.stopped = true;
  current = null;
  generation += 1;
}

function reportEvent(event, extra) {
  const state = current;
  if (!state || state.stopped) return;
  const session = loadSession();
  if (!session) return;
  const body = Object.assign({ sessionId: state.sessionId, event }, extra || {});
  void request(session, "/local/pi/event", { method: "POST", body }).catch(() => {});
}

async function runCommand(state, session, command) {
  let ok = true;
  let error = "";
  try {
    if (command.type === "prompt") {
      const text = String(command.text == null ? "" : command.text);
      if (!text.trim()) throw new Error("指令为空");
      const deliverAs = command.deliverAs === "steer" ? "steer" : "followUp";
      if (state.ctx.isIdle()) {
        try {
          state.pi.sendUserMessage(text);
        } catch (error) {
          state.pi.sendUserMessage(text, { deliverAs });
        }
      } else {
        state.pi.sendUserMessage(text, { deliverAs });
      }
    } else if (command.type === "abort") {
      state.ctx.abort();
    } else {
      throw new Error("未知控制指令: " + command.type);
    }
  } catch (error) {
    ok = false;
    error = (error && error.message) || String(error);
  }
  void request(session, "/local/pi/ack", {
    method: "POST",
    body: { sessionId: state.sessionId, id: command.id, ok, error },
  }).catch(() => {});
}

async function loop(state) {
  let delay = RECONNECT_MIN_MS;
  while (!state.stopped) {
    const session = loadSession();
    if (!session) {
      state.stopped = true;
      if (current === state) current = null;
      return;
    }
    try {
      await request(session, "/local/pi/session", {
        method: "POST",
        body: {
          sessionId: state.sessionId,
          sessionFile: state.sessionFile,
          cwd: state.cwd,
          pid: state.pid,
        },
      });
      delay = RECONNECT_MIN_MS;
      while (!state.stopped) {
        const data = await request(
          session,
          "/local/pi/commands?sessionId=" + encodeURIComponent(state.sessionId) + "&wait=" + POLL_WAIT_MS,
          { timeoutMs: POLL_TIMEOUT_MS }
        );
        const commands = data && Array.isArray(data.commands) ? data.commands : [];
        for (const command of commands) {
          if (state.stopped) break;
          await runCommand(state, session, command);
        }
      }
    } catch (error) {
      if (state.stopped) return;
      await sleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }
}

function ensureStarted(pi, ctx) {
  if (!ctx || ctx.mode !== "tui") return;
  if (current && !current.stopped) {
    current.ctx = ctx;
    return;
  }
  const info = sessionInfo(ctx);
  if (!info.sessionId) return;
  const state = {
    pi,
    ctx,
    sessionId: info.sessionId,
    sessionFile: info.sessionFile,
    cwd: info.cwd,
    pid: info.pid,
    stopped: false,
    generation: ++generation,
  };
  current = state;
  void loop(state).catch((error) => {
    console.error("[mo-agent] Pi 控制通道异常: " + ((error && error.message) || error));
  });
}

export default function (pi) {
  pi.on("session_start", (event, ctx) => {
    stopCurrent();
    ensureStarted(pi, ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    ensureStarted(pi, ctx);
  });

  pi.on("agent_settled", (event) => {
    reportEvent("agent_settled", { aborted: !!(event && event.aborted) });
  });

  pi.on("session_shutdown", () => {
    reportEvent("session_shutdown", {});
    stopCurrent();
  });
}

export { MARKER };
