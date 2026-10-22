import fs from "node:fs";
import path from "node:path";
import { grantAdminCookie, isAdminAuthed } from "./admin-auth.mjs";
import { isLoopback } from "./logs-http.mjs";

/**
 * 桌面端实时监控屏。
 *
 * 只给电脑本机看：和日志页一样要求回环地址 + 本机令牌/Cookie。
 * 页面本身不含数据；会话、待办和事件都从 /monitor/state 与 /monitor/events 现取，
 * 这样即使监控屏开着很久，看到的也始终是 host 的最新状态。
 */
const ROUTES = new Set(["/monitor", "/monitor/state", "/monitor/events"]);

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function deniedPage(res, status, detail) {
  html(res, status,
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />"
    + "<meta name='viewport' content='width=device-width, initial-scale=1' />"
    + "<title>mo-agent · 需要本机鉴权</title>"
    + "<style>body{margin:0;background:#0b1020;color:#e7ecff;font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif;"
    + "display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}"
    + ".box{max-width:560px;line-height:1.8}.title{font-size:20px;font-weight:700;margin-bottom:8px}"
    + ".sub{color:#8b97bd;font-size:13.5px}</style></head><body>"
    + "<div class='box'><div class='title'>实时监控仅限电脑本机</div>"
    + "<div class='sub'>" + detail + "</div></div></body></html>");
}

/** 会话状态汇总；running 同时兼容旧适配器里的 running 字段。 */
export function summarizeSessions(sessions) {
  const summary = {
    total: 0,
    running: 0,
    waiting: 0,
    healthy: 0,
    error: 0,
    completed: 0,
    idle: 0,
    attention: 0,
    branches: 0,
  };
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session) continue;
    summary.total += 1;
    if (session.parentId) summary.branches += 1;
    const status = session.status || "idle";
    if (status === "working" || status === "submitted" || (session.running && status !== "input-required" && status !== "auth-required")) {
      summary.running += 1;
    } else if (status === "input-required" || status === "auth-required") {
      summary.waiting += 1;
    } else if (status === "failed" || status === "rejected") {
      summary.error += 1;
    } else if (status === "completed" || status === "canceled") {
      summary.completed += 1;
    } else {
      summary.idle += 1;
    }
  }
  summary.attention = summary.waiting + summary.error;
  summary.healthy = Math.max(0, summary.total - summary.attention);
  return summary;
}

function recentSourceErrors(hub) {
  const bySource = {};
  try {
    const events = hub.store.since(0);
    for (const event of events) {
      if (event.type !== "source.error") continue;
      const payload = event.payload || {};
      bySource[payload.source || "unknown"] = {
        source: payload.source || "unknown",
        message: payload.message || "",
        at: event.at || null,
      };
    }
  } catch (error) {
    /* 事件缓存不可用时只是少了这层信息，不影响主流程 */
  }
  return Object.values(bySource);
}

/** 监控屏的一次完整快照。 */
export function buildMonitorSnapshot(ctx, now) {
  const at = Number(now) || Date.now();
  const sessions = ctx.hub.list();
  const approvals = ctx.broker && typeof ctx.broker.list === "function" ? ctx.broker.list() : [];
  const questions = ctx.monitor && ctx.monitor.pending ? [...ctx.monitor.pending.values()].map((item) => ({
    eventId: item.eventId,
    kind: item.kind,
    sessionId: item.sessionId || null,
    agentId: item.agentId || null,
    question: item.question || null,
  })) : [];
  const processes = ctx.processes && typeof ctx.processes.list === "function" ? ctx.processes.list() : [];
  const monitor = ctx.monitor ? {
    lastError: ctx.monitor.lastError || null,
    pollMs: ctx.monitor.pollMs || null,
    startedAt: ctx.monitor.startedAt || null,
    pending: ctx.monitor.pending ? ctx.monitor.pending.size : 0,
  } : null;
  return {
    ok: true,
    generatedAt: at,
    startedAt: ctx.hub.startedAt,
    uptimeMs: Math.max(0, at - ctx.hub.startedAt),
    seq: ctx.hub.store.seq,
    sources: [...ctx.hub.adapters.keys()],
    sourceErrors: recentSourceErrors(ctx.hub),
    summary: summarizeSessions(sessions),
    sessions,
    pending: { approvals, questions },
    processes,
    monitor,
    clients: ctx.runtime && typeof ctx.runtime.clientCount === "function" ? ctx.runtime.clientCount() : 0,
  };
}

function readMonitorPage(webDir) {
  const candidates = [
    webDir ? path.join(webDir, "monitor.html") : "",
    path.join(process.cwd(), "app", "web", "monitor.html"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    } catch (error) {
      /* 继续尝试下一个位置 */
    }
  }
  return null;
}

function streamMonitor(req, res, url, ctx) {
  const lastEventId = req.headers ? req.headers["last-event-id"] : "";
  const headerSince = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const since = Number(headerSince || url.searchParams.get("since") || 0) || 0;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 1500\n\n");

  const write = (event) => {
    try {
      res.write("id: " + event.seq + "\nevent: message\ndata: " + JSON.stringify(event) + "\n\n");
    } catch (error) {
      /* 客户端已断开 */
    }
  };

  // 断线重连只补状态类事件；notify / run.* 是一次性信号，补发会让旧事件看起来像刚发生。
  for (const event of ctx.hub.store.since(since)) {
    if (event.type === "notify" || event.type === "notice" || event.type.startsWith("run.")) continue;
    write(event);
  }

  const unsubscribe = ctx.hub.store.subscribe(write);
  const heartbeat = setInterval(() => {
    try { res.write(": ping " + Date.now() + "\n\n"); } catch (error) { /* 忽略 */ }
  }, 20000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", done);
  req.on("error", done);
  res.on("error", done);
  return true;
}

/** 处理 /monitor、/monitor/state、/monitor/events；已处理返回 true。 */
export async function handleMonitorRoutes(req, res, url, ctx) {
  const pathname = url.pathname;
  if (!ROUTES.has(pathname)) return false;
  if (req.method !== "GET") {
    json(res, 405, { ok: false, error: "method not allowed" });
    return true;
  }
  if (!isLoopback(req)) {
    if (pathname === "/monitor") deniedPage(res, 403, "监控屏不允许从局域网或外网访问。");
    else json(res, 403, { ok: false, error: "监控屏仅本机可访问" });
    return true;
  }
  if (!isAdminAuthed(req, url, ctx.localToken)) {
    if (pathname === "/monitor") deniedPage(res, 401, "缺少或无效的本机令牌。请从菜单栏的「打开监控屏」进入。");
    else json(res, 401, { ok: false, error: "缺少或无效的本机令牌" });
    return true;
  }
  grantAdminCookie(req, res, ctx.localToken, url);

  if (pathname === "/monitor/events") {
    streamMonitor(req, res, url, ctx);
    return true;
  }

  if (pathname === "/monitor/state") {
    json(res, 200, buildMonitorSnapshot(ctx));
    return true;
  }

  const page = readMonitorPage(ctx.webDir);
  if (!page) {
    html(res, 500, "<!doctype html><meta charset='utf-8' /><title>mo-agent · 监控屏</title>"
      + "<body style='background:#0b1020;color:#e7ecff;font-family:sans-serif;padding:24px'>"
      + "<h1>监控屏资源缺失</h1><p>找不到 app/web/monitor.html，请重新构建或安装 mo-agent。</p></body>");
    return true;
  }
  html(res, 200, page);
  return true;
}
