import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { buildPairPayload, candidateAddresses } from "./pairing.mjs";
import { handleLogRoutes } from "./logs-http.mjs";
import { canControl } from "../core/contract.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-mo-agent-token, x-mo-agent-local, last-event-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(value));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > (limit || 2 * 1024 * 1024)) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function localIPv4List() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === "IPv4" && !info.internal) result.push({ name, address: info.address });
    }
  }
  return result;
}

/** `::1` / `127.0.0.0/8` / IPv4-mapped 都算本机。配置管理只允许本机操作。 */
export function isLoopbackAddress(address) {
  if (!address) return false;
  const value = String(address).toLowerCase();
  if (value === "::1" || value === "localhost") return true;
  if (value.startsWith("::ffff:")) return value.slice(7).startsWith("127.");
  return value.startsWith("127.");
}

export function createMoAgentServer(options) {
  const config = options.config;
  const hub = options.hub;
  const broker = options.broker;
  const dsh = options.dsh;
  const processes = options.processes;
  const dshMonitor = options.monitor;
  const runtime = options.runtime;
  const log = options.log;
  const webDir = options.webDir;
  const localToken = options.localToken;
  const pairHandler = options.pairHandler;
  const apkPath = options.apkPath;
  const logFile = options.logFile;
  const deviceFile = options.deviceFile;
  const pushTokens = options.pushTokens;
  const hooksManager = options.hooksManager;

  const deviceTokens = new Set();

  // 持久化已配对设备：否则 host 一重启（含桌面「重启服务」）令牌全丢，
  // 手机必须重新配对，原生前台服务也会拿着旧令牌一直 401。
  const loadDeviceTokens = () => {
    if (!deviceFile) return;
    try {
      if (!fs.existsSync(deviceFile)) return;
      const list = JSON.parse(fs.readFileSync(deviceFile, "utf8"));
      if (Array.isArray(list)) for (const token of list) if (typeof token === "string" && token) deviceTokens.add(token);
      if (deviceTokens.size) log.info("已恢复 " + deviceTokens.size + " 个已配对设备");
    } catch (error) {
      log.warn("读取设备令牌失败: " + (error && error.message ? error.message : error));
    }
  };
  const saveDeviceTokens = () => {
    if (!deviceFile) return;
    try {
      fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
      fs.writeFileSync(deviceFile, JSON.stringify([...deviceTokens]), { mode: 0o600 });
    } catch (error) {
      log.warn("保存设备令牌失败: " + (error && error.message ? error.message : error));
    }
  };
  loadDeviceTokens();
  let pairPin = String(config.pin || "").trim();
  if (!pairPin) pairPin = String(Math.floor(100000 + Math.random() * 900000));
  let clients = 0;

  const deviceAuthed = (req, url) => {
    if (!config.authRequired) return true;
    const header = req.headers["x-mo-agent-token"];
    const token = (Array.isArray(header) ? header[0] : header) || url.searchParams.get("token");
    return !!token && deviceTokens.has(token);
  };
  const localAuthed = (req) => {
    const header = req.headers["x-mo-agent-local"];
    const token = Array.isArray(header) ? header[0] : header;
    return !!token && token === localToken;
  };

  // hook 里的 sessionId 是厂商原始 id（如 Claude 的 UUID），会话记录可能带 agent 前缀。
  // 两种都找一遍，找到就把会话标题补进通知正文。
  const sessionFor = (payload) => {
    const raw = payload && payload.sessionId ? String(payload.sessionId) : "";
    if (!raw) return null;
    const candidates = [raw];
    if (payload.agent) candidates.push(payload.agent + ":" + raw);
    for (const id of candidates) {
      const found = hub.get(id);
      if (found) return found;
    }
    return null;
  };

  const boundPort = () => {
    const addr = server.address();
    return addr && addr.port ? addr.port : config.port;
  };
  const pairingPin = () => pairPin;

  // 手动「换一个配对码」：二维码令牌和 6 位码一起换
  const renewPairing = () => {
    options.pairing.issue();
    pairPin = String(Math.floor(100000 + Math.random() * 900000));
    return pairPin;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://mo-agent.local");
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, x-mo-agent-token, x-mo-agent-local, last-event-id",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    try {
      // ---- 公开 ----
      if (pathname === "/api/pair" && req.method === "POST") {
        const body = await readBody(req);
        const byQr = !!(body.qrToken && options.pairing && options.pairing.redeem(body.qrToken));
        if (!byQr && config.authRequired && String(body.pin || "").trim() !== pairPin) {
          return json(res, 401, { ok: false, error: "配对码不正确" });
        }
        const token = randomBytes(24).toString("base64url");
        deviceTokens.add(token);
        saveDeviceTokens();
        log.info("新设备已配对，当前设备数 " + deviceTokens.size);
        return json(res, 200, { ok: true, token, authRequired: config.authRequired });
      }
      if (pathname === "/api/health") {
        return json(res, 200, { ok: true, seq: hub.store.seq, sources: [...hub.adapters.keys()], clients, sessions: hub.agents.size });
      }

      // ---- 扫码配对页面（公开） ----
      // 前端把未捕获错误送过来，写进 host.log —— 手机上看不到 console，这是唯一线索
      if (pathname === "/api/client-error" && req.method === "POST") {
        try {
          const body = await readBody(req);
          log.warn("[client-error] " + (body.kind || "") + " " + String(body.detail || "").slice(0, 500) + " | page=" + String(body.url || "").slice(0, 120));
        } catch (error) { /* 记不下来也不影响页面 */ }
        return json(res, 200, { ok: true });
      }

      if (pathname === "/app/version" && req.method === "GET") {
        const infoPath = apkPath ? apkPath.replace(/[^/]+$/, "version.json") : null;
        let info = {};
        try { info = JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch (error) { info = {}; }
        let size = 0;
        try { size = apkPath ? fs.statSync(apkPath).size : 0; } catch (error) { size = 0; }
        return json(res, 200, { ok: true, versionCode: info.versionCode || null, versionName: info.versionName || null, builtAt: info.builtAt || null, size });
      }

      if (pathname === "/app.apk" && req.method === "GET") {
        if (!apkPath || !fs.existsSync(apkPath)) {
          return json(res, 404, { ok: false, error: "APK 尚未构建，请先运行 scripts/build-android.sh" });
        }
        const stat = fs.statSync(apkPath);
        res.writeHead(200, {
          "content-type": "application/vnd.android.package-archive",
          "content-length": stat.size,
          "content-disposition": 'attachment; filename="mo-agent.apk"',
          "cache-control": "no-store",
        });
        return fs.createReadStream(apkPath).pipe(res);
      }

      if (pairHandler) {
        let apkInfo = {};
        try { apkInfo = JSON.parse(fs.readFileSync(apkPath.replace(/[^/]+$/, "version.json"), "utf8")); } catch (error) { apkInfo = {}; }
        const handled = await pairHandler(req, res, url, {
          pairing: options.pairing,
          pin: pairingPin(),
          port: boundPort(),
          preferredAddress: options.preferredAddress || null,
          apkExists: !!(apkPath && fs.existsSync(apkPath)),
          apkSizeText: apkPath && fs.existsSync(apkPath) ? (fs.statSync(apkPath).size / 1048576).toFixed(1) + " MB" : "",
          apkVersionText: apkInfo.versionCode ? "构建 v" + apkInfo.versionCode + " · " + String(apkInfo.builtAt || "").slice(0, 16).replace("T", " ") : "",
          apkVersionCode: apkInfo.versionCode || 0,
          renewPairing,
          hooksManager,
          isLoopback: isLoopbackAddress(req.socket && req.socket.remoteAddress),
        });
        if (handled) return;
      }

      // ---- 日志页面（仅本机） ----
      if (logFile) {
        const handled = await handleLogRoutes(req, res, url, { logFile });
        if (handled) return;
      }

      // ---- Agent 配置管理（仅本机；局域网里的手机不能改电脑配置） ----
      if (pathname === "/local/hooks" && req.method === "GET") {
        if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
          return json(res, 403, { ok: false, error: "仅限电脑本机" });
        }
        if (!hooksManager) return json(res, 503, { ok: false, error: "hooks-manager-unavailable" });
        return json(res, 200, { ok: true, agents: hooksManager.status() });
      }
      if (pathname === "/local/hooks/apply" && req.method === "POST") {
        if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
          return json(res, 403, { ok: false, error: "仅限电脑本机" });
        }
        // 自定义头会触发浏览器预检；跨站页面无法伪造，避免被网页顺手改配置。
        if (req.headers["x-mo-agent-hooks"] !== "1") {
          return json(res, 403, { ok: false, error: "缺少 x-mo-agent-hooks: 1 请求头" });
        }
        if (!hooksManager) return json(res, 503, { ok: false, error: "hooks-manager-unavailable" });
        const body = await readBody(req);
        const results = hooksManager.apply({
          agentId: body.agentId,
          action: body.action,
          dryRun: body.dryRun === true,
        });
        return json(res, 200, { ok: results.every((item) => item.ok), results });
      }

      // ---- 本机专用（hook 回调用） ----
      if (pathname === "/local/approval" && req.method === "POST") {
        if (!localAuthed(req)) return json(res, 401, { ok: false, error: "local token invalid" });
        const body = await readBody(req);
        const session = sessionFor(body);
        const payload = Object.assign({}, body);
        if (!payload.sessionTitle && session && session.title) payload.sessionTitle = session.title;
        const result = await broker.request(payload);
        return json(res, 200, result);
      }
      if (pathname === "/local/voice-test" && req.method === "POST") {
        if (!localAuthed(req)) return json(res, 401, { ok: false, error: "local token invalid" });
        if (typeof options.voiceTest !== "function") {
          return json(res, 503, { ok: false, error: "voice-disabled" });
        }
        const result = await options.voiceTest();
        return json(res, 200, result);
      }
      // P1 语音命令：一次请求 = 提示语 + 听一次 + 解析 + 执行（需要时再回读确认）。
      if (pathname === "/local/voice-command" && req.method === "POST") {
        if (!localAuthed(req)) return json(res, 401, { ok: false, error: "local token invalid" });
        if (typeof options.voiceCommand !== "function") {
          return json(res, 503, { ok: false, error: "voice-disabled" });
        }
        const result = await options.voiceCommand();
        return json(res, 200, result);
      }
      // P2 语音口述：一段话 → 草稿 → 回读 → 严格确认 → 只发送一次。
      if (pathname === "/local/dictate" && req.method === "POST") {
        if (!localAuthed(req)) return json(res, 401, { ok: false, error: "local token invalid" });
        if (typeof options.dictate !== "function") {
          return json(res, 503, { ok: false, error: "voice-disabled" });
        }
        const result = await options.dictate();
        return json(res, 200, result);
      }
      // 语音浮层的实时事件流（本机 token 放 query，EventSource 不能带 header）。
      if (pathname === "/local/voice-events" && req.method === "GET") {
        const token = url.searchParams.get("token");
        if (!token || token !== localToken) {
          return json(res, 401, { ok: false, error: "local token invalid" });
        }
        if (!options.voiceEvents || typeof options.voiceEvents.subscribe !== "function") {
          return json(res, 503, { ok: false, error: "voice-events-unavailable" });
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": "*",
        });
        res.write("retry: 2000\n\n");
        const send = (event) => {
          try {
            res.write("data: " + JSON.stringify(event) + "\n\n");
          } catch (error) {
            /* 客户端已断开 */
          }
        };
        const unsubscribe = options.voiceEvents.subscribe(send);
        const heartbeat = setInterval(() => {
          try { res.write(": ping " + Date.now() + "\n\n"); } catch (error) { /* 忽略 */ }
        }, 15000);
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
        return;
      }
      if (pathname === "/local/pair-payload" && req.method === "GET") {
        if (!localAuthed(req)) return json(res, 401, { ok: false, error: "local token invalid" });
        const addresses = candidateAddresses(localIPv4List());
        const address = addresses.length ? addresses[0].address : "127.0.0.1";
        const baseUrl = "http://" + address + ":" + boundPort();
        const issued = options.pairing ? options.pairing.peek() : null;
        return json(res, 200, { ok: true, baseUrl, token: issued ? issued.token : null, payload: issued ? buildPairPayload(baseUrl, issued.token) : null, addresses, pin: pairPin });
      }

      if (pathname === "/local/notify" && req.method === "POST") {
        if (!localAuthed(req)) return json(res, 401, { ok: false, error: "local token invalid" });
        const body = await readBody(req);
        const session = sessionFor(body);
        // 标题只表达事件类型，Agent 名由 NOTIFY_POLICY 统一追加成「标题 [Agent]」；
        // 正文留原始内容，由策略拼上会话标题。
        hub.emit("notice", {
          kind: body.kind || "attention",
          severity: body.severity || null,
          title: body.noticeTitle || body.title || "提醒",
          body: body.body || "",
          sessionId: body.sessionId || null,
          agent: body.agent || null,
          agentLabel: body.agentLabel || "Agent",
          sessionTitle: body.sessionTitle || (session && session.title) || "",
          notificationType: body.notificationType || null,
        });
        return json(res, 200, { ok: true });
      }

      // ---- 需设备令牌 ----
      if (pathname.startsWith("/api/") && !deviceAuthed(req, url)) {
        return json(res, 401, { ok: false, error: "未配对或令牌无效" });
      }

      if (pathname === "/api/push-token" && req.method === "POST") {
        const body = await readBody(req);
        const token = String(body.token || "").trim();
        if (!token) return json(res, 400, { ok: false, error: "缺少 token" });
        const count = pushTokens ? pushTokens.add(token) : 0;
        log.info("已登记设备 push token，共 " + count + " 个");
        return json(res, 200, { ok: true, count });
      }

      if (pathname === "/api/state" && req.method === "GET") {
        return json(res, 200, {
          ok: true,
          state: hub.snapshot({
            approvals: broker.list(),
            questions: dshMonitor && dshMonitor.pending ? [...dshMonitor.pending.values()] : [],
            processes: processes ? processes.list() : [],
            peers: broker.pending ? broker.pending.size : 0,
          }),
        });
      }

      if (pathname === "/api/session-history" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) return json(res, 400, { ok: false, error: "缺少 sessionId" });
        const session = hub.get(sessionId);
        if (!session) return json(res, 404, { ok: false, error: "会话不存在或已离线" });
        const adapter = hub.adapters.get(session.agent);
        if (!adapter || typeof adapter.history !== "function") {
          return json(res, 501, { ok: false, error: (session.agentLabel || session.agent) + " 暂不支持历史记录" });
        }
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
        try {
          const history = await adapter.history(sessionId, { limit });
          return json(res, 200, {
            ok: true,
            agent: session.agent,
            agentLabel: session.agentLabel,
            turns: history.turns || [],
            truncated: !!history.truncated,
            total: history.total || (history.turns ? history.turns.length : 0),
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: "读取历史失败: " + (error && error.message ? error.message : error) });
        }
      }

      if (pathname === "/api/events" && req.method === "GET") {
        const remote = (req.socket && req.socket.remoteAddress) || "?";
        const clientTag = String(req.headers["x-mo-agent-client"] || "").trim();
        const ua = String(req.headers["user-agent"] || "no-ua").slice(0, 60);
        log.info("SSE 接入 " + remote + (clientTag ? " [" + clientTag + "]" : "") + " ua=" + ua);
        return streamEvents(req, res, url, hub.store, log, () => {
          clients += 1;
          return () => {
            clients -= 1;
            log.info("SSE 断开 " + remote + "（当前在线 " + clients + "）");
          };
        });
      }

      if (pathname === "/api/approve" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.id || !body.decision) return json(res, 400, { ok: false, error: "缺少 id 或 decision" });
        const extra = body.answers && typeof body.answers === "object" && Object.keys(body.answers).length
          ? { answers: body.answers }
          : {};
        const done = broker.decide(body.id, body.decision, extra);
        log.info("手机已应答 " + body.id + " -> " + body.decision
          + (extra.answers ? "（含 " + Object.keys(extra.answers).length + " 个答案）" : "")
          + (done ? "" : " (已失效)"));
        return json(res, 200, { ok: done, error: done ? undefined : "该请求已结束" });
      }

      if (pathname === "/api/approvals" && req.method === "GET") {
        return json(res, 200, { ok: true, pending: broker.list() });
      }

      if (pathname === "/api/processes" && req.method === "GET") {
        return json(res, 200, { ok: true, processes: processes ? processes.list() : [] });
      }

      if (pathname === "/api/prompt" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.sessionId || !String(body.text || "").trim()) return json(res, 400, { ok: false, error: "缺少 sessionId 或 text" });
        const session = hub.get(body.sessionId);
        if (!session) return json(res, 404, { ok: false, error: "会话不存在或已离线" });
        if (!canControl(session, "prompt")) {
          return json(res, 409, { ok: false, error: (session.agentLabel || session.agent || "该 Agent") + " 会话仅观测，不能发送指令" });
        }
        if (!dsh) return json(res, 503, { ok: false, error: "控制通道不可用" });
        const value = await dsh.prompt(body.sessionId, String(body.text), body.mode);
        log.info("已向会话 " + body.sessionId + " 发送指令");
        return json(res, 200, { ok: true, value });
      }

      if (pathname === "/api/cancel" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.sessionId) return json(res, 400, { ok: false, error: "缺少 sessionId" });
        const session = hub.get(body.sessionId);
        if (!session) return json(res, 404, { ok: false, error: "会话不存在或已离线" });
        if (!canControl(session, "cancel")) {
          return json(res, 409, { ok: false, error: (session.agentLabel || session.agent || "该 Agent") + " 会话仅观测，不能中断" });
        }
        if (!dsh) return json(res, 503, { ok: false, error: "控制通道不可用" });
        const value = await dsh.cancel(body.sessionId);
        log.info("已请求中断会话 " + body.sessionId);
        return json(res, 200, { ok: true, value });
      }

      if (pathname === "/api/answer" && req.method === "POST") {
        if (!dsh) return json(res, 503, { ok: false, error: "DSH 数据源不可用" });
        const body = await readBody(req);
        if (!body.eventId) return json(res, 400, { ok: false, error: "缺少 eventId" });
        let outcome = body.outcome;
        if (!outcome) {
          if (body.cancel) outcome = { kind: "rejected", error: { code: "cancelled", message: "用户取消了本次询问" } };
          else if (Array.isArray(body.answers)) outcome = { kind: "result", value: { answers: body.answers } };
          else if (body.approval) outcome = { kind: "result", value: body.approval };
          else return json(res, 400, { ok: false, error: "缺少 outcome / answers / approval" });
        }
        await dsh.answer(body.eventId, outcome);
        if (options.monitor) options.monitor.resolvePending(body.eventId, body.cancel ? "cancelled" : "answered");
        return json(res, 200, { ok: true });
      }

      if (pathname === "/api/session" && req.method === "POST") {
        if (!dsh) return json(res, 503, { ok: false, error: "DSH 数据源不可用" });
        const body = await readBody(req);
        if (!body.cwd) return json(res, 400, { ok: false, error: "缺少 cwd" });
        const value = await dsh.createSession(body.cwd, body.agentPreset);
        return json(res, 200, { ok: true, value });
      }

      if (pathname.startsWith("/api/")) return json(res, 404, { ok: false, error: "not found" });

      serveStatic(res, webDir, pathname);
    } catch (error) {
      log.error("HTTP 处理失败: " + (error && error.message ? error.message : String(error)));
      if (!res.headersSent) json(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
      else res.end();
    }
  });

  return {
    server,
    pin: pairPin,
    clientCount: () => clients,
    deviceCount: () => deviceTokens.size,
    localToken,
  };
}

/** M4 起只发统一 message 信封；旧 named event 已删除。 */
export function formatSseEvent(event) {
  return "id: " + event.seq + "\nevent: message\ndata: " + JSON.stringify(event) + "\n\n";
}

function streamEvents(req, res, url, store, log, onOpen) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  res.write("retry: 2000\n\n");
  const cleanup = onOpen ? onOpen() : () => {};

  const lastEventId = req.headers["last-event-id"];
  const hdr = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const since = Number(hdr || url.searchParams.get("since") || 0) || 0;

  const write = (event) => res.write(formatSseEvent(event));

  const backlog = store.since(since);
  if (backlog.length) log.debug("SSE 重放 " + backlog.length + " 条事件 (since=" + since + ")");
  for (const event of backlog) {
    // 只重放状态类事件（会话、待办）。notify / run.* / notice 是一次性信号，
    // 重放会让通知重复弹、或让旧一轮的完成事件看起来像刚发生。
    if (event.type === "notify" || event.type === "notice" || event.type.startsWith("run.")) continue;
    write(event);
  }

  const unsubscribe = store.subscribe(write);
  const heartbeat = setInterval(() => res.write(": ping " + Date.now() + "\n\n"), 20000);
  // close / error 可能各触发一次，清理必须幂等：否则 clients 会越减越负，
  // 而远程批准中枢用 clients > 0 判断「手机在不在线」，负值会让授权全部 DEFER。
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    cleanup();
  };
  req.on("close", done);
  req.on("error", done);
  res.on("error", done);
}

function serveStatic(res, webDir, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const target = path.normalize(path.join(webDir, rel));
  if (!target.startsWith(webDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

