import { ACTIVE, INTERRUPTED, LABELS } from "../../core/status.mjs";
import { listenOnce } from "./confirm.mjs";
import { INTENT as REPLY, normalizeReply, parseReply } from "./text.mjs";

/**
 * P1 语音命令：解析 + 执行。
 *
 * 边界（与 docs/adr/adr-0002-hands-free-voice.md 一致）：
 *  - 只处理状态查询、暂停/继续语音、切换「当前关注会话」、帮助；
 *  - 「暂停」只静音语音播报与语音审批，不暂停 Agent 进程；
 *  - 「切换」只设置关注会话，不切前台窗口；
 *  - 未知、低置信度、歧义一律不执行。
 *
 * 本文件不碰麦克风：listen 由调用方注入（host 用语音通道，测试用脚本）。
 */

export const COMMAND = Object.freeze({
  STATUS: "status",
  PAUSE: "pause",
  RESUME: "resume",
  SWITCH: "switch",
  HELP: "help",
  UNKNOWN: "unknown",
});

export const HELP_TEXT = "可以这样说：汇报状态、暂停、继续、切到第 2 个、切换到会话名、帮助。";

const SWITCH_RE = /^(?:请|帮我|麻烦|给我)?(?:切换|切|换|转)(?:到|至|去)(.+)$/;
const PAUSE_RE = /(暂停|静音|停一下|停一停|先停|别念|不要念|别播报|不要播报|闭麦|安静)/;
const RESUME_RE = /(继续|恢复|取消静音|解除静音|别静音|不用静音|开声音|打开声音|取消暂停|解除暂停)/;
const RESUME_PHRASE_RE = /(取消静音|解除静音|别静音|不用静音|取消暂停|解除暂停)/g;
const MUTE_QUESTION_RE = /(静音了吗|静音了没|静音多久|静音多长时间|是否静音|是不是静音|还静音吗|静音状态|现在静音吗|还有多久恢复|多久恢复)/;
const STATUS_RE = /(状态|情况|怎么样|几个会话|几个任务|几个窗口|多少会话|多少任务|汇报|报告|进展|忙不忙|在干嘛|在干什么|有什么在跑|跑得怎么样|还在跑)/;
const HELP_RE = /(帮助|能做什么|会做什么|帮我做什么|怎么用|使用说明|有什么命令|有哪些命令|命令列表|help)/;

const CN_DIGITS = {
  "零": 0, "〇": 0, "○": 0,
  "一": 1, "壹": 1, "幺": 1,
  "二": 2, "两": 2, "贰": 2,
  "三": 3, "叁": 3,
  "四": 4, "肆": 4,
  "五": 5, "伍": 5,
  "六": 6, "陆": 6,
  "七": 7, "柒": 7,
  "八": 8, "捌": 8,
  "九": 9, "玖": 9,
};

/** 「12」「十二」「两」都转成数字；不认识返回 null。 */
function parseNumber(text) {
  const value = String(text == null ? "" : text).trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (value.indexOf("十") !== -1) {
    const parts = value.split("十");
    if (parts.length !== 2) return null;
    const tens = parts[0] ? CN_DIGITS[parts[0]] : 1;
    const ones = parts[1] ? CN_DIGITS[parts[1]] : 0;
    if (typeof tens !== "number" || typeof ones !== "number") return null;
    return tens * 10 + ones;
  }
  let out = "";
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) out += String(CN_DIGITS[ch]);
    else return null;
  }
  return out ? Number(out) : null;
}

function parseSwitchHint(raw) {
  let text = String(raw == null ? "" : raw).trim().replace(/(?:吧|啊|呢|一下)$/u, "");
  text = text.replace(/^(?:名叫|叫|名为)/u, "");

  const indexMatch = /^第([0-9零〇○一二两三四五六七八九十百]+)(?:个|号)?(?:会话|任务|窗口|聊天|对话)?(?:的)?$/u.exec(text);
  if (indexMatch) {
    const index = parseNumber(indexMatch[1]);
    if (index && index > 0) return { kind: "index", index };
    return null;
  }

  const title = text
    .replace(/^(?:会话|任务|窗口|聊天|对话)/u, "")
    .replace(/(?:的)?(?:会话|任务|窗口|聊天|对话)$/u, "")
    .trim();
  if (!title) return null;
  return { kind: "title", text: title };
}

/**
 * 把一句话解析成命令。优先级：切换 > 暂停/继续 > 状态 > 帮助。
 * 同时命中两类（例如「暂停一下看看状态」）视为歧义，返回 unknown。
 */
export function parseCommand(text) {
  const normalized = normalizeReply(text);
  if (!normalized) {
    return { intent: COMMAND.UNKNOWN, sessionHint: null, normalized, reason: "empty" };
  }

  const switchMatch = SWITCH_RE.exec(normalized);
  if (switchMatch) {
    const hint = parseSwitchHint(switchMatch[1]);
    if (hint) return { intent: COMMAND.SWITCH, sessionHint: hint, normalized };
    return { intent: COMMAND.UNKNOWN, sessionHint: null, normalized, reason: "switch-no-target" };
  }

  // 「静音了吗」是在问状态，不是命令静音。
  if (MUTE_QUESTION_RE.test(normalized)) {
    return { intent: COMMAND.STATUS, sessionHint: null, normalized };
  }

  // 「取消静音 / 别静音」里的「静音」不算暂停命令。
  const pauseText = normalized.replace(RESUME_PHRASE_RE, "");
  const hits = [];
  if (PAUSE_RE.test(pauseText)) hits.push(COMMAND.PAUSE);
  if (RESUME_RE.test(normalized)) hits.push(COMMAND.RESUME);
  if (STATUS_RE.test(normalized)) hits.push(COMMAND.STATUS);
  if (HELP_RE.test(normalized)) hits.push(COMMAND.HELP);

  if (hits.length > 1) {
    return { intent: COMMAND.UNKNOWN, sessionHint: null, normalized, reason: "ambiguous", candidates: hits };
  }
  if (hits.length === 1) {
    return { intent: hits[0], sessionHint: null, normalized };
  }
  return { intent: COMMAND.UNKNOWN, sessionHint: null, normalized, reason: "no-match" };
}

function isRunning(session) {
  return !!session.running || ACTIVE.has(session.status);
}

function isWaiting(session) {
  return INTERRUPTED.has(session.status) || (Array.isArray(session.pending) && session.pending.length > 0);
}

function byActive(session) {
  return isRunning(session) || isWaiting(session);
}

/**
 * 命令执行器：持有「当前关注会话」与「静音截止时间」，并负责回读确认。
 *
 * options = {
 *   hub, broker, speak(text), listen({ timeoutMs }), log, now,
 *   muteMinutes, timeoutMs, minConfidence, maxCandidates
 * }
 */
export function createCommandExecutor(options) {
  const opts = options || {};
  const hub = opts.hub || { list: function () { return []; }, get: function () { return null; } };
  const broker = opts.broker || { list: function () { return []; } };
  const speak = typeof opts.speak === "function" ? opts.speak : async function () {};
  const listen = opts.listen;
  const log = opts.log || { info: function () {}, warn: function () {} };
  const now = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };
  const muteMinutes = Math.max(1, Number(opts.muteMinutes) || 15);
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const minConfidence = typeof opts.minConfidence === "number" ? opts.minConfidence : 0.35;
  const maxCandidates = Math.max(1, Number(opts.maxCandidates) || 5);

  let targetSessionId = null;
  let mutedUntil = 0;

  function isMuted() {
    return mutedUntil > now();
  }

  function remainingMinutes() {
    return Math.max(1, Math.ceil((mutedUntil - now()) / 60000));
  }

  function sessions() {
    try {
      return hub.list() || [];
    } catch (error) {
      return [];
    }
  }

  function activeSessions() {
    const all = sessions().filter(function (item) { return item && item.id; });
    const active = all.filter(byActive);
    if (active.length) return active;
    const visible = all.filter(function (item) { return !item.blank; });
    return visible.length ? visible : all;
  }

  function pendingApprovals() {
    try {
      return broker.list() || [];
    } catch (error) {
      return [];
    }
  }

  function titleOf(session) {
    return String((session && (session.title || session.id)) || "未命名会话");
  }

  function statusLabel(session) {
    if (!session) return "未知";
    if (LABELS[session.status]) return LABELS[session.status];
    if (session.running) return "运行中";
    return "空闲";
  }

  function findTarget() {
    if (!targetSessionId) return null;
    try {
      const found = hub.get ? hub.get(targetSessionId) : null;
      if (found) return found;
    } catch (error) {
      /* 继续用列表查 */
    }
    return sessions().find(function (item) { return item && item.id === targetSessionId; }) || null;
  }

  function candidateText(list) {
    const active = activeSessions();
    return list.slice(0, maxCandidates).map(function (session) {
      const index = active.findIndex(function (item) { return item.id === session.id; });
      const head = index >= 0 ? (index + 1) + ". " : "";
      return head + titleOf(session) + "（" + statusLabel(session) + "）";
    }).join("；");
  }

  function candidates(list) {
    const active = activeSessions();
    return list.slice(0, maxCandidates).map(function (session) {
      return {
        id: session.id,
        title: titleOf(session),
        status: session.status,
        index: active.findIndex(function (item) { return item.id === session.id; }) + 1 || null,
      };
    });
  }

  function statusSnapshot() {
    const list = sessions();
    const target = findTarget();
    const pending = pendingApprovals();
    return {
      sessions: list.length,
      running: list.filter(isRunning).length,
      waiting: list.filter(isWaiting).length,
      approvals: pending.length,
      targetSessionId,
      target: target ? { id: target.id, title: titleOf(target), status: statusLabel(target) } : null,
      muted: isMuted(),
      mutedUntil: isMuted() ? mutedUntil : 0,
      muteRemainingMinutes: isMuted() ? remainingMinutes() : 0,
    };
  }

  function statusReply(snapshot) {
    const state = snapshot || statusSnapshot();
    const parts = [];
    if (state.target) parts.push("当前关注「" + state.target.title + "」（" + state.target.status + "）。");
    else if (state.targetSessionId) parts.push("当前关注的会话已不在线。");
    else parts.push("未设置关注会话。");
    parts.push("共 " + state.sessions + " 个会话，" + state.running + " 个运行中，" + state.waiting + " 个等待。");
    parts.push(state.approvals ? "待授权 " + state.approvals + " 个。" : "当前没有待授权。");
    parts.push(state.muted ? "语音已静音，还剩 " + state.muteRemainingMinutes + " 分钟。" : "语音未静音。");
    return parts.join("");
  }

  function matchTitle(session, fragment) {
    const want = String(fragment || "").toLowerCase();
    if (!want) return false;
    const title = String(session.title || "");
    if (title.toLowerCase().includes(want)) return true;
    if (normalizeReply(title).includes(normalizeReply(want))) return true;
    return String(session.id || "") === fragment;
  }

  function resolveSwitch(hint) {
    if (!hint) {
      const list = activeSessions();
      return {
        ok: false,
        action: "not-found",
        reply: "要切换到哪个会话？" + (list.length ? "可选：" + candidateText(list) : "当前没有会话。"),
        candidates: candidates(list),
      };
    }

    if (hint.kind === "index") {
      const list = activeSessions();
      if (hint.index >= 1 && hint.index <= list.length) {
        const session = list[hint.index - 1];
        return {
          ok: true,
          session,
          label: "第 " + hint.index + " 个会话「" + titleOf(session) + "」",
        };
      }
      return {
        ok: false,
        action: "not-found",
        reply: "只有 " + list.length + " 个会话。" + (list.length ? "可选：" + candidateText(list) : "当前没有会话。"),
        candidates: candidates(list),
      };
    }

    const matches = sessions().filter(function (session) { return matchTitle(session, hint.text); });
    if (matches.length === 1) {
      return { ok: true, session: matches[0], label: "会话「" + titleOf(matches[0]) + "」" };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        action: "ambiguous",
        reply: "找到 " + matches.length + " 个会话，请说切到第几个。可选：" + candidateText(matches),
        candidates: candidates(matches),
      };
    }
    const list = activeSessions();
    return {
      ok: false,
      action: "not-found",
      reply: "找不到「" + hint.text + "」。" + (list.length ? "当前会话：" + candidateText(list) : "当前没有会话。"),
      candidates: candidates(list),
    };
  }

  function prepare(intent, hint) {
    if (intent === COMMAND.PAUSE) {
      if (isMuted()) {
        return { ok: false, action: "noop", reply: "语音已经静音，还剩 " + remainingMinutes() + " 分钟。" };
      }
      return {
        ok: true,
        kind: "pause",
        prompt: "要暂停语音播报与语音审批 " + muteMinutes + " 分钟，确认吗？",
      };
    }
    if (intent === COMMAND.RESUME) {
      if (!isMuted()) return { ok: false, action: "noop", reply: "语音没有静音。" };
      return { ok: true, kind: "resume", prompt: "要恢复语音播报与语音审批，确认吗？" };
    }
    if (intent === COMMAND.SWITCH) {
      const resolved = resolveSwitch(hint);
      if (!resolved.ok) {
        return {
          ok: false,
          action: resolved.action,
          reply: resolved.reply,
          candidates: resolved.candidates,
        };
      }
      return {
        ok: true,
        kind: "switch",
        session: resolved.session,
        label: resolved.label,
        prompt: "要切换到" + resolved.label + "，确认吗？",
      };
    }
    return { ok: false, action: "unknown", reply: "没听懂。" };
  }

  function apply(plan) {
    if (plan.kind === "pause") {
      mutedUntil = now() + muteMinutes * 60000;
      return {
        action: "muted",
        reply: "已暂停语音播报与语音审批 " + muteMinutes + " 分钟。审批仍会进入待办，手机和终端可以处理。",
      };
    }
    if (plan.kind === "resume") {
      mutedUntil = 0;
      return { action: "unmuted", reply: "已恢复语音播报与语音审批。" };
    }
    if (plan.kind === "switch") {
      targetSessionId = plan.session.id;
      return { action: "switched", sessionId: targetSessionId, reply: "已切换到" + plan.label + "。" };
    }
    return { action: "noop", reply: "没有可执行的动作。" };
  }

  async function safeSpeak(text) {
    try {
      await speak(text);
    } catch (error) {
      if (typeof log.warn === "function") {
        log.warn("语音命令播报失败: " + (error && error.message ? error.message : String(error)));
      }
    }
  }

  async function execute(parsed) {
    const intent = parsed && parsed.intent ? parsed.intent : COMMAND.UNKNOWN;

    if (intent === COMMAND.STATUS) {
      const snapshot = statusSnapshot();
      const reply = statusReply(snapshot);
      await safeSpeak(reply);
      return { ok: true, reply, action: "reported", snapshot };
    }

    if (intent === COMMAND.HELP) {
      await safeSpeak(HELP_TEXT);
      return { ok: true, reply: HELP_TEXT, action: "help" };
    }

    if (intent === COMMAND.UNKNOWN) {
      const reply = "没听懂。" + HELP_TEXT;
      await safeSpeak(reply);
      return { ok: false, reply, action: "unknown" };
    }

    const plan = prepare(intent, parsed && parsed.sessionHint);
    if (!plan.ok) {
      await safeSpeak(plan.reply);
      return { ok: false, reply: plan.reply, action: plan.action, candidates: plan.candidates };
    }

    // 有副作用的命令：先回读，再听一次明确确认；不认数字口令。
    await safeSpeak(plan.prompt);
    const heard = await listenOnce({ io: { listen }, timeoutMs, minConfidence });
    if (!heard.ok) {
      const reply = heard.error === "timeout" ? "没有听到确认，未执行。" : "没听清，未执行。";
      await safeSpeak(reply);
      return { ok: false, reply, action: "cancelled", heard, error: heard.error };
    }
    if (!heard.text.trim() || heard.lowConfidence) {
      const reply = "没听清，未执行。";
      await safeSpeak(reply);
      return { ok: false, reply, action: "cancelled", heard };
    }

    const replyIntent = parseReply(heard.text).intent;
    if (replyIntent !== REPLY.CONFIRM) {
      const cancelled = replyIntent === REPLY.CANCEL || replyIntent === REPLY.REJECT;
      const reply = cancelled ? "已取消，未执行。" : "没有确认，未执行。";
      await safeSpeak(reply);
      return { ok: false, reply, action: "cancelled", heard, replyIntent };
    }

    const applied = apply(plan);
    await safeSpeak(applied.reply);
    return {
      ok: true,
      reply: applied.reply,
      action: applied.action,
      sessionId: applied.sessionId || null,
      muted: isMuted(),
      mutedUntil: isMuted() ? mutedUntil : 0,
      targetSessionId,
    };
  }

  function describeOutcome(intent, result) {
    if (result.action === "muted") return "muted " + muteMinutes + "min";
    if (result.action === "unmuted") return "unmuted";
    if (result.action === "switched") return "switched " + result.sessionId;
    if (result.action === "reported") return "reported";
    if (result.action === "help") return "help";
    if (result.action === "noop") return "noop";
    if (result.action === "cancelled") return "cancelled";
    if (result.action === "not-found") return "switch-not-found";
    if (result.action === "ambiguous") return "switch-ambiguous";
    if (result.action === "unknown") return "unknown";
    if (result.action === "error") return "failed";
    return result.ok ? "ok" : "failed";
  }

  async function dispatch(text, info) {
    const heard = {
      text: String(text == null ? "" : text),
      confidence: info && typeof info.confidence === "number" ? info.confidence : null,
    };
    const parsed = parseCommand(heard.text);
    let result;
    try {
      result = await execute(parsed);
    } catch (error) {
      if (typeof log.warn === "function") {
        log.warn("语音命令执行失败: " + (error && error.message ? error.message : String(error)));
      }
      result = { ok: false, reply: "命令执行失败，请稍后再试。", action: "error" };
    }

    const outcome = describeOutcome(parsed.intent, result);
    if (typeof log.info === "function") {
      log.info("语音命令: 文本=「" + heard.text + "」 intent=" + parsed.intent + " 结果=" + outcome);
    }

    const value = {
      ok: !!result.ok,
      intent: parsed.intent,
      heard,
      reply: result.reply,
      action: result.action,
      muted: isMuted(),
      mutedUntil: isMuted() ? mutedUntil : 0,
      targetSessionId,
    };
    if (result.candidates) value.candidates = result.candidates;
    if (result.snapshot) value.snapshot = result.snapshot;
    return value;
  }

  async function runFromMicrophone() {
    if (typeof listen !== "function") {
      return { ok: false, intent: COMMAND.UNKNOWN, heard: null, reply: "语音输入不可用。", error: "no-listener" };
    }

    await safeSpeak("请说命令。");
    const heard = await listenOnce({ io: { listen }, timeoutMs, minConfidence });

    if (!heard.ok) {
      const reply = heard.error === "timeout" ? "没有听到命令。" : "麦克风不可用，请检查语音设置。";
      if (typeof log.info === "function") {
        log.info("语音命令: 文本=「」 intent=unknown 结果=failed:" + (heard.error || "unknown"));
      }
      await safeSpeak(reply);
      return { ok: false, intent: COMMAND.UNKNOWN, heard, reply, error: heard.error };
    }

    if (!heard.text.trim()) {
      if (typeof log.info === "function") {
        log.info("语音命令: 文本=「」 intent=unknown 结果=empty");
      }
      const reply = "没有听到命令。";
      await safeSpeak(reply);
      return { ok: false, intent: COMMAND.UNKNOWN, heard, reply, action: "empty" };
    }

    if (heard.lowConfidence) {
      if (typeof log.info === "function") {
        const confidence = heard.confidence === null ? "-" : heard.confidence.toFixed(2);
        log.info("语音命令: 文本=「" + heard.text + "」 intent=unknown 结果=low-confidence 置信度=" + confidence);
      }
      const reply = "没听清，请再说一遍。";
      await safeSpeak(reply);
      return { ok: false, intent: COMMAND.UNKNOWN, heard, reply, action: "low-confidence" };
    }

    return dispatch(heard.text, { confidence: heard.confidence });
  }

  return {
    parse: parseCommand,
    dispatch,
    execute,
    runFromMicrophone,
    statusSnapshot,
    statusReply,
    resolveSwitch,
    isMuted,
    mutedUntil: function () { return isMuted() ? mutedUntil : 0; },
    muteMinutes: function () { return muteMinutes; },
    targetSessionId: function () { return targetSessionId; },
    setTarget: function (id) { targetSessionId = id || null; },
    mute: function () { mutedUntil = now() + muteMinutes * 60000; return mutedUntil; },
    unmute: function () { mutedUntil = 0; },
  };
}
