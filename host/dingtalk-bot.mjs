import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { DECISION } from "../approvals/broker.mjs";
import { loadChannelConfigs } from "./notify-webhook.mjs";
import { createDingTalkStream } from "./dingtalk-stream.mjs";
import { createDingTalkFetch } from "./dingtalk-http.mjs";
import { createUsageStore } from "./dingtalk-usage.mjs";

/**
 * 钉钉单应用机器人通道。
 *
 * - 入站：Stream（官方 SDK）→ 固定文本审批回复 / 首次绑定
 * - 出站：sessionWebhook 优先，过期后回落 oToMessages / groupMessages
 * - 计次：所有 HTTP 走 dingtalk-http，local 逐条记；成功消息记 billable
 * - 安全：只认绑定用户；审批只认「A 短码」「D 短码」完全匹配
 */

const API_BASE = "https://api.dingtalk.com";
const OAPI_BASE = "https://oapi.dingtalk.com";
const DEFAULT_SOURCE = "MO_AGENT";
const SEEN_TTL_MS = 30 * 60 * 1000;
const SHORT_ID_TTL_MS = 24 * 60 * 60 * 1000;
const BIND_SUCCESS_TEXT = [
  "绑定成功 ✅",
  "",
  "**Mo Agent，让智能随行，让掌控随心。**",
  "",
  "Mo Agent 是你电脑上的一位 AI Agent 小监理，叫我 Momo，也叫“默默”。",
  "",
  "Momo 不会替 Agent们 干活，也不会改变你的工作方式。Agent们 照旧在终端和 IDE 里忙碌；Momo 会守在旁边，默默看着进度，在它需要授权、等待回答、完成任务或失败的那一刻，把消息递到你面前。你只需一句回复，事情就能继续。",
  "",
  "Momo 会推送审批消息及短码（如 A3F2）",
  "你只须回复：「A A3F2」代表同意、「D A3F2」代表拒绝（空格可省略、可多个）",
].join("\n");

const ACTION_KINDS = new Set(["approval", "question", "error"]);
const DEFAULT_EVENTS = Object.freeze({
  approval: true,
  question: true,
  error: true,
  completed: false,
  canceled: false,
  attention: false,
});

function mask(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 6) return text.slice(0, 2) + "***";
  return text.slice(0, 3) + "***" + text.slice(-2);
}

function severityRank(value) {
  if (value === "critical") return 2;
  if (value === "normal") return 1;
  return 0;
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function inQuietHours(quietHours, at) {
  if (!quietHours || !quietHours.start || !quietHours.end) return false;
  const start = parseClock(quietHours.start);
  const end = parseClock(quietHours.end);
  if (start === null || end === null) return false;
  const date = new Date(at);
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function shortIdFor(eventId, used) {
  const base = String(eventId || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!base) return "";
  for (const length of [4, 6, 8]) {
    const candidate = base.slice(0, length);
    if (candidate && !used.has(candidate)) return candidate;
  }
  return base.slice(0, 8);
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (error) { /* ignore */ }
}

export function normalizeDingTalkBotConfig(raw, options) {
  const opts = options || {};
  const input = raw || {};
  const usage = input.usage || {};
  const binding = input.binding || {};
  return {
    enabled: input.enabled !== false,
    clientId: String(input.clientId || ""),
    clientSecret: String(input.clientSecret || ""),
    robotCode: String(input.robotCode || ""),
    target: {
      mode: input.target && input.target.mode === "group" ? "group" : "dm",
      userId: String((input.target && input.target.userId) || ""),
      openConversationId: String((input.target && input.target.openConversationId) || ""),
    },
    events: Object.assign({}, DEFAULT_EVENTS, input.events || {}),
    severityMin: input.severityMin || "critical",
    aggregateMs: Number.isFinite(Number(input.aggregateMs)) ? Number(input.aggregateMs) : 15000,
    maxPerMinute: Number.isFinite(Number(input.maxPerMinute)) ? Number(input.maxPerMinute) : 10,
    quietHours: input.quietHours || null,
    usage: {
      monthlyLimit: Number.isFinite(Number(usage.monthlyLimit)) ? Number(usage.monthlyLimit) : 3000,
      warnAt: Number.isFinite(Number(usage.warnAt)) ? Number(usage.warnAt) : 0.8,
      confirmOnlyAt: Number.isFinite(Number(usage.confirmOnlyAt)) ? Number(usage.confirmOnlyAt) : 1,
      hardStopAt: Number.isFinite(Number(usage.hardStopAt)) ? Number(usage.hardStopAt) : 1.2,
      stopOnQuotaError: usage.stopOnQuotaError !== false,
    },
    binding: {
      windowMs: Number.isFinite(Number(binding.windowMs)) ? Number(binding.windowMs) : 300000,
      autoBindFirst: binding.autoBindFirst !== false,
      requireConfirm: binding.requireConfirm !== false,
      codeTtlMs: Number.isFinite(Number(binding.codeTtlMs)) ? Number(binding.codeTtlMs) : 300000,
    },
    allowedUserIds: Array.isArray(input.allowedUserIds) ? input.allowedUserIds.map(String) : [],
    allowedConversationIds: Array.isArray(input.allowedConversationIds) ? input.allowedConversationIds.map(String) : [],
    corpId: String(input.corpId || ""),
    allowFreeText: false,
    audit: input.audit !== false,
    source: String(input.source || DEFAULT_SOURCE),
    bindingFile: opts.bindingFile || process.env.MO_AGENT_DINGTALK_BINDING_FILE || path.join(os.homedir(), ".mo-agent", "dingtalk.json"),
    auditFile: opts.auditFile || process.env.MO_AGENT_DINGTALK_AUDIT_FILE || path.join(os.homedir(), ".mo-agent", "dingtalk-audit.log"),
  };
}

export function loadDingTalkBotConfig(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const configs = loadChannelConfigs({ log, env: opts.env, file: opts.file });
  const raw = configs.find((item) => item && item.type === "dingtalk-bot");
  if (!raw) return null;
  if (raw.enabled === false) return null;
  if (!raw.clientId || !raw.clientSecret) {
    log.warn("钉钉通道缺少 clientId/clientSecret，已跳过");
    return null;
  }
  return normalizeDingTalkBotConfig(raw, opts);
}

export function createDingTalkBot(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const config = normalizeDingTalkBotConfig(opts.config, opts);
  const now = opts.now || Date.now;
  const broker = opts.broker || null;
  const usage = opts.usage || createUsageStore({
    ...config.usage,
    channel: "dingtalk-bot",
    log,
    now,
    file: opts.usageFile,
  });
  const fetchImpl = opts.fetchImpl || createDingTalkFetch({ meter: usage, log, now });
  const streamFactory = opts.streamFactory || createDingTalkStream;

  let binding = readJson(config.bindingFile);
  if (binding && !binding.userId && !binding.conversationId) binding = null;
  let bindingState = binding ? "bound" : "unbound";
  let bindingExpiresAt = 0;
  let bindingCode = "";
  let bindingCodeAttempts = 0;
  let pendingBind = null;
  let stream = null;
  let lastError = null;
  let lastInboundAt = null;
  let lastOutboundAt = null;
  let apiToken = null;
  let apiTokenExpiresAt = 0;
  let oapiToken = null;
  let oapiTokenExpiresAt = 0;

  const seen = new Map();
  const shortIds = new Map();
  const sentTimes = [];
  const aggregates = new Map();

  function audit(entry) {
    if (!config.audit) return;
    try {
      fs.mkdirSync(path.dirname(config.auditFile), { recursive: true });
      fs.appendFileSync(config.auditFile, JSON.stringify(Object.assign({ at: now() }, entry)) + "\n", { mode: 0o600 });
    } catch (error) {
      log.warn("写钉钉审计日志失败: " + (error && error.message ? error.message : error));
    }
  }

  function saveBinding() {
    if (!binding) {
      try { fs.rmSync(config.bindingFile, { force: true }); } catch (error) { /* ignore */ }
      return;
    }
    try {
      writeJsonAtomic(config.bindingFile, binding);
    } catch (error) {
      log.warn("保存钉钉绑定失败: " + (error && error.message ? error.message : error));
    }
  }

  function pruneShortIds() {
    const cutoff = now() - SHORT_ID_TTL_MS;
    for (const [key, value] of shortIds) {
      if (!value || value.at < cutoff) shortIds.delete(key);
    }
  }

  function setShortId(eventId, kind) {
    if (!eventId) return "";
    for (const [key, value] of shortIds) {
      if (value && value.eventId === eventId) return key;
    }
    pruneShortIds();
    const used = new Set(shortIds.keys());
    const candidate = shortIdFor(eventId, used);
    if (candidate) shortIds.set(candidate, { eventId, kind, at: now() });
    return candidate;
  }

  function rebuildShortIds() {
    if (!broker || typeof broker.list !== "function") return;
    const used = new Set(shortIds.keys());
    for (const item of broker.list()) {
      if (!item || !item.id) continue;
      const exists = [...shortIds.values()].some((value) => value && value.eventId === item.id);
      if (exists) continue;
      const candidate = shortIdFor(item.id, used);
      if (!candidate) continue;
      used.add(candidate);
      shortIds.set(candidate, { eventId: item.id, kind: item.kind || "approval", at: now() });
    }
  }

  function resolveShortId(id) {
    const key = String(id || "").toUpperCase();
    const found = shortIds.get(key);
    if (found) return found;
    rebuildShortIds();
    return shortIds.get(key) || null;
  }

  function tokenIsFresh(expiresAt) {
    return Boolean(expiresAt) && now() < expiresAt - 60000;
  }

  async function getApiToken(force) {
    if (!force && apiToken && tokenIsFresh(apiTokenExpiresAt)) return apiToken;
    const response = await fetchImpl(API_BASE + "/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: config.clientId, appSecret: config.clientSecret }),
    }, { api: "oauth2/accessToken", category: "api" });
    const data = await response.json().catch(() => ({}));
    const token = data && (data.accessToken || data.access_token);
    if (!response.ok || !token) {
      throw new Error("钉钉 accessToken 获取失败: " + JSON.stringify(data).slice(0, 200));
    }
    apiToken = token;
    apiTokenExpiresAt = now() + (Number(data.expireIn || data.expires_in) || 7200) * 1000;
    return apiToken;
  }

  async function getOapiToken(force) {
    if (!force && oapiToken && tokenIsFresh(oapiTokenExpiresAt)) return oapiToken;
    const url = OAPI_BASE + "/gettoken?appkey=" + encodeURIComponent(config.clientId) + "&appsecret=" + encodeURIComponent(config.clientSecret);
    const response = await fetchImpl(url, { method: "GET" }, { api: "gettoken", category: "api" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error("钉钉 oapi token 获取失败: " + JSON.stringify(data).slice(0, 200));
    }
    oapiToken = data.access_token;
    oapiTokenExpiresAt = now() + (Number(data.expires_in) || 7200) * 1000;
    return oapiToken;
  }

  function classifyError(status, data) {
    const text = JSON.stringify(data || {}) + " " + (status || "");
    if (/session.*(expired|notexist)|300001/i.test(text)) return "session-expired";
    if (/too\.?fast|tooFast|ratelimit|rate limit/i.test(text)) return "rate-limited";
    if (/quota|exceed|额度|超限|limit.*(exceed|reached)/i.test(text)) return "quota";
    return "failed";
  }

  function bindingTarget() {
    if (!binding) return null;
    if (config.target.mode === "group") {
      const conversationId = binding.openConversationId || binding.conversationId || config.target.openConversationId;
      if (!conversationId) return null;
      return { mode: "group", openConversationId: conversationId };
    }
    const userId = binding.userId || config.target.userId;
    if (!userId) return null;
    return { mode: "dm", userId };
  }

  async function postSessionWebhook(webhook, title, text) {
    const token = await getOapiToken();
    const response = await fetchImpl(webhook, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify({ msgtype: "markdown", markdown: { title: title || "mo-agent", text } }),
    }, { api: "robot/sendBySession", category: "stream" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data.errcode && data.errcode !== 0)) {
      const error = new Error("钉钉 sessionWebhook 发送失败: " + JSON.stringify(data).slice(0, 200));
      error.kind = classifyError(response.status, data);
      throw error;
    }
    return data;
  }

  async function sendViaSession(title, text) {
    if (!binding || !binding.sessionWebhook) throw new Error("session-webhook-missing");
    if (binding.sessionWebhookExpiredTime && now() > Number(binding.sessionWebhookExpiredTime) - 5000) {
      binding.sessionWebhook = "";
      saveBinding();
      throw new Error("session-webhook-expired");
    }
    await postSessionWebhook(binding.sessionWebhook, title, text);
  }

  async function sendViaApi(title, text) {
    const target = bindingTarget();
    if (!target) throw new Error("no-target");
    const robotCode = binding.robotCode || config.robotCode;
    if (!robotCode) throw new Error("missing-robotCode");

    let url;
    let body;
    let api;
    if (target.mode === "group") {
      url = API_BASE + "/v1.0/robot/groupMessages/send";
      api = "robot/groupMessages/send";
      body = { robotCode, openConversationId: target.openConversationId, msgKey: "sampleMarkdown", msgParam: JSON.stringify({ title, text }) };
    } else {
      url = API_BASE + "/v1.0/robot/oToMessages/batchSend";
      api = "robot/oToMessages/batchSend";
      body = { robotCode, userIds: [target.userId], msgKey: "sampleMarkdown", msgParam: JSON.stringify({ title, text }) };
    }

    let token = await getApiToken(false);
    let response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(body),
    }, { api, category: "stream" });

    if (response.status === 401) {
      token = await getApiToken(true);
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
        body: JSON.stringify(body),
      }, { api, category: "stream" });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data.code && data.code !== 0 && data.code !== "0")) {
      const error = new Error("钉钉机器人发送失败: " + JSON.stringify(data).slice(0, 200));
      error.kind = classifyError(response.status, data);
      throw error;
    }
    return data;
  }

  function noteSendSuccess(kind) {
    lastOutboundAt = now();
    usage.recordBillable({ kind: kind || "message", direction: "out" });
  }

  function noteSendFailure(error) {
    lastError = error && error.message ? error.message : String(error);
    if (error && error.kind === "quota" && config.usage.stopOnQuotaError) {
      usage.markQuotaExhausted(error.message);
      log.warn("钉钉额度受限，已停止出站: " + error.message);
    }
  }

  function buildSingle(intent) {
    const title = intent.title || "mo-agent";
    let id = "";
    const isAction = intent.kind === "approval" || intent.kind === "question";
    if (isAction && intent.eventId) id = setShortId(intent.eventId, intent.kind);
    let body = intent.body || "";
    if (id) body = "#" + id + (body ? " " + body : "");
    let text = title + "\n\n" + body;
    if (id) text += "\n\n回复：A " + id + " 同意 / D " + id + " 拒绝";
    return { title, text, id };
  }

  function enqueueAggregate(intent) {
    const key = String(intent.sessionId || "global") + ":" + String(intent.kind || "attention");
    let entry = aggregates.get(key);
    if (!entry) {
      entry = {
        items: [],
        timer: null,
        kind: intent.kind,
        severity: intent.severity,
        requiresAction: intent.requiresAction,
        sessionId: intent.sessionId || null,
      };
      entry.timer = setTimeout(() => {
        flushAggregate(key).catch((error) => log.warn("钉钉聚合发送失败: " + (error && error.message ? error.message : error)));
      }, config.aggregateMs);
      if (typeof entry.timer.unref === "function") entry.timer.unref();
      aggregates.set(key, entry);
    }
    const built = buildSingle(intent);
    entry.items.push({
      title: intent.title || "mo-agent",
      body: intent.body || "",
      id: built.id,
      sessionTitle: intent.sessionTitle || "",
      eventId: intent.eventId || null,
      kind: intent.kind,
    });
    entry.requiresAction = intent.requiresAction;
    return true;
  }

  async function flushAggregate(key) {
    const entry = aggregates.get(key);
    if (!entry) return;
    aggregates.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    const items = entry.items;
    if (!items.length) return;

    const base = items[0];
    const title = items.length > 1 ? base.title + " · " + items.length + " 项" : base.title;
    let text = title + "\n\n";
    if (items.length > 1 && base.sessionTitle) text += base.sessionTitle + "\n";
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      text += (items.length > 1 ? (i + 1) + ". " : "") + (item.id ? "#" + item.id + " " : "") + (item.body || "") + "\n";
    }
    const ids = items.map((item) => item.id).filter(Boolean);
    if (ids.length) {
      text += "\n回复：A " + ids[0] + " 同意 / D " + ids[0] + " 拒绝" + (ids.length > 1 ? "（按短码）" : "");
    }

    const synthetic = {
      kind: entry.kind,
      severity: entry.severity,
      requiresAction: entry.requiresAction,
      sessionId: entry.sessionId,
    };
    if (!accepts(synthetic)) return;
    await deliverText(synthetic, title, text);
  }

  async function deliverText(intent, title, text) {
    const nowAt = now();
    while (sentTimes.length && nowAt - sentTimes[0] > 60000) sentTimes.shift();
    if (sentTimes.length >= config.maxPerMinute) {
      log.warn("钉钉出站超过本地节流上限，丢弃: " + (intent.title || intent.kind));
      return false;
    }

    try {
      try {
        await sendViaSession(title, text);
      } catch (sessionError) {
        const fallback = !sessionError.kind
          || sessionError.kind === "session-expired"
          || /missing|expired/i.test(sessionError.message || "");
        if (!fallback) throw sessionError;
        if (sessionError.kind === "session-expired") {
          binding.sessionWebhook = "";
          saveBinding();
        }
        await sendViaApi(title, text);
      }
      noteSendSuccess(intent.kind);
      sentTimes.push(nowAt);
      audit({ action: "send", kind: intent.kind, title, ok: true });
      return true;
    } catch (error) {
      noteSendFailure(error);
      audit({ action: "send", kind: intent.kind, title, ok: false, error: error && error.message ? error.message : String(error) });
      log.warn("钉钉发送失败: " + (error && error.message ? error.message : error));
      return false;
    }
  }

  async function send(intent) {
    if (!accepts(intent)) return false;
    if (config.aggregateMs > 0 && ACTION_KINDS.has(intent.kind) && intent.eventId) {
      return enqueueAggregate(intent);
    }
    const built = buildSingle(intent);
    return deliverText(intent, built.title, built.text);
  }

  function accepts(intent) {
    if (!config.enabled || !intent) return false;
    if (!isBound()) return false;
    const kind = intent.kind || "attention";
    if (config.events[kind] === false) return false;
    if (severityRank(intent.severity) < severityRank(config.severityMin)) return false;
    if (inQuietHours(config.quietHours, now())) {
      const allow = Array.isArray(config.quietHours.allow) ? config.quietHours.allow : [];
      if (!allow.includes(kind)) return false;
    }
    const requiresAction = intent.requiresAction === true || ACTION_KINDS.has(kind);
    const gate = usage.canSend({ requiresAction });
    if (!gate.allow) {
      log.warn("钉钉出站被预算闸门拦截: " + gate.reason + " (" + Math.round((gate.percent || 0) * 100) + "%)");
      return false;
    }
    return Boolean(bindingTarget());
  }

  async function replyTo(message, text, kind) {
    const title = "mo-agent";
    try {
      if (message && message.sessionWebhook) {
        await postSessionWebhook(message.sessionWebhook, title, text);
      } else {
        await sendViaApi(title, text);
      }
      usage.recordBillable({ kind: kind || "reply", direction: "out" });
      lastOutboundAt = now();
      return true;
    } catch (error) {
      noteSendFailure(error);
      log.warn("钉钉回复失败: " + (error && error.message ? error.message : error));
      return false;
    }
  }

  function commitBinding(candidate) {
    binding = {
      userId: candidate.userId || "",
      conversationId: candidate.conversationId || "",
      conversationType: candidate.conversationType || 1,
      robotCode: candidate.robotCode || config.robotCode || "",
      sessionWebhook: candidate.sessionWebhook || "",
      sessionWebhookExpiredTime: Number(candidate.sessionWebhookExpiredTime) || 0,
      senderNick: candidate.senderNick || "",
      boundAt: now(),
    };
    if (binding.conversationType === 2) binding.openConversationId = candidate.conversationId || "";
    saveBinding();
    bindingState = "bound";
    bindingExpiresAt = 0;
    bindingCode = "";
    bindingCodeAttempts = 0;
    pendingBind = null;
    log.info("钉钉已绑定: " + mask(binding.userId) + " / " + mask(binding.conversationId));
    audit({ action: "bind", userId: binding.userId, conversationId: binding.conversationId, ok: true });
  }

  function parseDecision(text) {
    const value = String(text || "").trim().toUpperCase();
    let match = /^([AD])\s*([0-9A-F]{4,6})$/.exec(value);
    if (match) return { approve: match[1] === "A", id: match[2] };
    match = /^批准\s*([0-9A-F]{4,6})$/.exec(value);
    if (match) return { approve: true, id: match[1] };
    match = /^拒绝\s*([0-9A-F]{4,6})$/.exec(value);
    if (match) return { approve: false, id: match[1] };
    return null;
  }

  async function handleFixedReply(message, text) {
    const parsed = parseDecision(text);
    if (!parsed) {
      await replyTo(message, "未识别。请回复「A A3F2」表示同意，或「D A3F2」表示拒绝。", "reply");
      return;
    }
    const { approve, id } = parsed;
    const target = resolveShortId(id);
    if (!target) {
      await replyTo(message, "未找到 " + id, "reply");
      audit({ action: "decide", id, ok: false, reason: "not-found" });
      return;
    }
    if (!broker || typeof broker.decide !== "function") {
      await replyTo(message, "处理失败 " + id + "：审批服务不可用", "reply");
      return;
    }
    const decision = approve ? DECISION.ALLOW_ONCE : DECISION.REJECT_ONCE;
    const ok = broker.decide(target.eventId, decision);
    if (ok) {
      shortIds.delete(id);
      await replyTo(message, (approve ? "已同意 " : "已拒绝 ") + id, "reply");
      audit({ action: "decide", id, eventId: target.eventId, decision, ok: true });
    } else {
      await replyTo(message, "已处理 " + id, "reply");
      audit({ action: "decide", id, eventId: target.eventId, ok: false, reason: "already-handled" });
    }
  }

  async function handleFrame(frame) {
    const messageId = frame && frame.headers && frame.headers.messageId;
    if (messageId && stream) stream.ack(messageId, { status: "SUCCESS" });

    let message;
    try {
      message = typeof (frame && frame.data) === "string" ? JSON.parse(frame.data) : (frame && frame.data);
    } catch (error) {
      return;
    }
    if (!message || typeof message !== "object") return;

    const msgId = String(message.msgId || "");
    if (msgId) {
      if (seen.has(msgId)) return;
      seen.set(msgId, now());
      for (const [key, value] of seen) if (now() - value > SEEN_TTL_MS) seen.delete(key);
    }

    usage.record({
      api: "stream.event",
      category: "stream",
      ok: true,
      billable: true,
      kind: "event",
      direction: "in",
      at: now(),
    });
    lastInboundAt = now();

    const sender = String(message.senderStaffId || message.senderId || "");
    const conversationId = String(message.conversationId || "");
    const conversationType = Number(message.conversationType) || (conversationId ? 1 : 1);
    const text = String((message.text && message.text.content) || "").trim();
    const corpId = String(message.chatbotCorpId || "");
    const inbound = {
      userId: sender,
      conversationId,
      conversationType,
      robotCode: String(message.robotCode || ""),
      sessionWebhook: String(message.sessionWebhook || ""),
      sessionWebhookExpiredTime: Number(message.sessionWebhookExpiredTime) || 0,
      senderNick: String(message.senderNick || ""),
      text,
    };

    if (config.corpId && corpId && config.corpId !== corpId) return;
    if (bindingState === "unbound") return;

    if (bindingState === "waiting") {
      if (bindingExpiresAt && now() > bindingExpiresAt) {
        bindingState = "unbound";
        bindingCode = "";
        pendingBind = null;
        return;
      }
      if (config.target.mode === "dm" && conversationType !== 1) return;
      if (config.target.mode === "group" && conversationType !== 2) return;
      if (config.allowedUserIds.length && !config.allowedUserIds.includes(sender)) return;

      if (bindingCode && text === bindingCode) {
        commitBinding(inbound);
        await replyTo(inbound, BIND_SUCCESS_TEXT, "reply");
        return;
      }
      if (bindingCode) {
        bindingCodeAttempts += 1;
        if (bindingCodeAttempts > 5) {
          bindingState = "unbound";
          bindingCode = "";
          await replyTo(inbound, "配对码错误次数过多，请在设置页重新生成。", "reply");
        } else {
          await replyTo(inbound, "配对码不正确，请发送设置页显示的 6 位配对码。", "reply");
        }
        return;
      }

      // 兼容没有配对码的旧状态：首条消息直接绑定。
      commitBinding(inbound);
      await replyTo(inbound, BIND_SUCCESS_TEXT, "reply");
      return;
    }

    if (!binding || binding.userId !== sender) {
      if (config.target.mode === "group" && conversationType === 2 && binding && binding.openConversationId === conversationId) {
        // 群模式下允许同一群的其他成员看到消息，但只响应绑定用户；这里静默忽略。
      }
      return;
    }

    if (binding.conversationId !== conversationId) {
      binding.conversationId = conversationId;
      binding.conversationType = conversationType;
      if (conversationType === 2) binding.openConversationId = conversationId;
    }
    if (inbound.sessionWebhook) {
      binding.sessionWebhook = inbound.sessionWebhook;
      binding.sessionWebhookExpiredTime = inbound.sessionWebhookExpiredTime;
    }
    if (inbound.robotCode) binding.robotCode = inbound.robotCode;
    saveBinding();

    try {
      await handleFixedReply(inbound, text);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      log.warn("处理钉钉回复失败: " + lastError);
      await replyTo(inbound, "处理失败，请稍后重试", "reply");
    }
  }

  function isBound() {
    return bindingState === "bound" && Boolean(binding) && Boolean(bindingTarget());
  }

  return {
    name: "dingtalk-bot",
    config,
    usage,

    async start() {
      if (!config.enabled) return false;
      if (!config.clientId || !config.clientSecret) {
        log.warn("钉钉通道未配置凭证，跳过启动");
        return false;
      }
      stream = streamFactory({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        log,
        onStatus: (status) => {
          log.info("钉钉 Stream 状态: " + status);
        },
        onError: (error) => {
          lastError = error && error.message ? error.message : String(error);
          log.warn("钉钉 Stream 错误: " + lastError);
        },
        onMessage: (frame) => handleFrame(frame).catch((error) => {
          lastError = error && error.message ? error.message : String(error);
          log.warn("处理钉钉消息失败: " + lastError);
        }),
      });
      await stream.start();
      return true;
    },

    stop() {
      for (const entry of aggregates.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      aggregates.clear();
      if (stream) stream.stop();
      usage.flush();
    },

    accepts,
    send,

    getState() {
      const target = bindingTarget();
      return {
        configured: Boolean(config.clientId && config.clientSecret),
        enabled: config.enabled,
        connected: Boolean(stream && stream.isConnected()),
        status: stream ? stream.getStatus() : "stopped",
        lastError,
        lastInboundAt,
        lastOutboundAt,
        binding: {
          state: bindingState,
          boundAt: binding ? binding.boundAt : null,
          expiresAt: bindingExpiresAt || null,
          code: bindingState === "waiting" ? bindingCode : "",
          pendingNick: pendingBind ? pendingBind.senderNick : null,
          userId: binding ? mask(binding.userId) : "",
          conversationId: binding ? mask(binding.conversationId) : "",
          mode: config.target.mode,
        },
        usage: usage.snapshot(),
      };
    },

    isBound,
    isAvailable() {
      return isBound() && Boolean(stream && stream.isConnected());
    },

    startBinding() {
      if (isBound()) return { ok: false, error: "already-bound" };
      bindingState = "waiting";
      bindingExpiresAt = now() + config.binding.windowMs;
      bindingCode = String(randomInt(0, 1000000)).padStart(6, "0");
      bindingCodeAttempts = 0;
      pendingBind = null;
      return { ok: true, code: bindingCode, expiresAt: bindingExpiresAt };
    },

    async confirmBinding() {
      if (bindingState !== "pending_confirm" || !pendingBind) return false;
      commitBinding(pendingBind);
      try {
        await sendViaApi("mo-agent", BIND_SUCCESS_TEXT);
        usage.recordBillable({ kind: "reply", direction: "out" });
        lastOutboundAt = now();
      } catch (error) {
        log.warn("钉钉绑定回执发送失败: " + (error && error.message ? error.message : error));
      }
      return true;
    },

    rejectBinding() {
      bindingState = "unbound";
      bindingExpiresAt = 0;
      bindingCode = "";
      pendingBind = null;
    },

    unbind() {
      binding = null;
      bindingState = "unbound";
      bindingExpiresAt = 0;
      bindingCode = "";
      pendingBind = null;
      saveBinding();
      audit({ action: "unbind", ok: true });
    },

    /** 测试与监控用：重新读取绑定文件。 */
    reloadBinding() {
      binding = readJson(config.bindingFile);
      if (binding && !binding.userId && !binding.conversationId) binding = null;
      bindingState = binding ? "bound" : "unbound";
      return Boolean(binding);
    },
  };
}
