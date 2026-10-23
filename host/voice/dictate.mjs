import { ACTIVE, INTERRUPTED } from "../../core/status.mjs";
import { listenOnce } from "./confirm.mjs";
import {
  INTENT,
  buildDictationDraft,
  clipText,
  isDictationConfirm,
  parseReply,
} from "./text.mjs";

/**
 * P2 语音口述任务：一段话 → 草稿 → 回读 → 严格确认 → 只发送一次。
 *
 * 边界（docs/plans/p2-plan.md）：
 *  - click-to-talk，不做唤醒词、不常开麦克风；
 *  - 目标沿用 P1 的「当前关注会话」；没有关注会话时只在恰好 1 个活跃会话时自动选；
 *  - 任何不确定（超时、低置信度、空文本、目标不明确、发送失败）都不发送；
 *  - 发送只走注入的 sendPrompt（host 里是 dsh.prompt），失败不重试、不换 Agent。
 *
 * 本文件不碰麦克风：listen / speak / prepare 由 host 注入，测试用脚本。
 */

export const DICTATION_INTENT = "dictate";
export const DICTATE_PROMPT = "请说你要交给 Agent 的内容，说完停一下。";

const RETRYABLE_LISTEN_ERRORS = ["timeout", "mic-silent", "route-changed"];
const MIC_UNAVAILABLE_ERRORS = [
  "mic-denied", "speech-denied", "capture-failed", "open-failed", "no-meta", "engine-failed",
];
const LOG_PREVIEW = 200;

function isRunning(session) {
  return !!session.running || ACTIVE.has(session.status);
}

function isWaiting(session) {
  return INTERRUPTED.has(session.status) ||
    (Array.isArray(session.pending) && session.pending.length > 0);
}

function byActive(session) {
  return isRunning(session) || isWaiting(session);
}

function charsOf(text) {
  return Array.from(String(text == null ? "" : text)).length;
}

/**
 * options = {
 *   hub, getTargetSessionId, sendPrompt(sessionId, text),
 *   listen({ timeoutMs, prompt, silence, maxSeconds, threshold }),
 *   speak(text), prepare(), log, onEvent, now,
 *   maxChars, maxAttempts, timeoutMs, confirmTimeoutMs, silence, maxSeconds, threshold,
 *   minConfidence, listenDelayMs, resultDelayMs, maxCandidates
 * }
 */
export function createDictationRunner(options) {
  const opts = options || {};
  const hub = opts.hub || {
    list: function () { return []; },
    get: function () { return null; },
  };
  const getTargetSessionId = typeof opts.getTargetSessionId === "function"
    ? opts.getTargetSessionId
    : function () { return null; };
  const sendPrompt = opts.sendPrompt;
  const listen = opts.listen;
  const speak = typeof opts.speak === "function" ? opts.speak : async function () {};
  const prepare = typeof opts.prepare === "function" ? opts.prepare : null;
  const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
  const log = opts.log || { info: function () {}, warn: function () {}, debug: function () {} };
  const now = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };

  // 口述比命令长：默认断句静音 1.6 秒、最长 30 秒、整体超时 45 秒。
  const maxChars = Math.max(1, Number(opts.maxChars) || 4000);
  const listenAttempts = Math.max(1, Number(opts.maxAttempts) || 2);
  const confirmAttempts = Math.max(1, Number(opts.confirmAttempts) || 2);
  const timeoutMs = Number(opts.timeoutMs) || 45000;
  const confirmTimeoutMs = Number(opts.confirmTimeoutMs) || 15000;
  const silence = typeof opts.silence === "number" ? opts.silence : 1.6;
  const maxSeconds = Number(opts.maxSeconds) || 30;
  const threshold = typeof opts.threshold === "number" ? opts.threshold : undefined;
  const minConfidence = typeof opts.minConfidence === "number" ? opts.minConfidence : 0.35;
  const listenDelayMs = opts.listenDelayMs === 0 ? 0 : Math.max(0, Number(opts.listenDelayMs) || 500);
  const resultDelayMs = opts.resultDelayMs === 0 ? 0 : Math.max(0, Number(opts.resultDelayMs) || 180);
  const maxCandidates = Math.max(1, Number(opts.maxCandidates) || 5);

  function logInfo(line) {
    if (typeof log.info === "function") log.info(line);
  }

  function logWarn(line) {
    if (typeof log.warn === "function") log.warn(line);
  }

  function emitEvent(event) {
    if (!onEvent) return;
    try {
      onEvent(Object.assign({ at: Date.now(), intent: DICTATION_INTENT }, event));
    } catch (error) {
      logWarn("语音口述: 事件发送失败 " + (error && error.message ? error.message : String(error)));
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function elapsed(started) {
    return now() - started;
  }

  function confidenceText(value) {
    return typeof value === "number" ? value.toFixed(2) : "-";
  }

  function recordText(record, detail) {
    const info = record || detail || null;
    if (!info) return "";
    const parts = [];
    if (info.startupMs !== undefined) parts.push("启动=" + info.startupMs + "ms");
    if (info.buffers !== undefined) parts.push("缓冲=" + info.buffers);
    if (typeof info.peak === "number") parts.push("峰值=" + info.peak.toFixed(4));
    if (info.sampleRate) parts.push("采样率=" + info.sampleRate);
    if (info.routeChanged) parts.push("路由变化");
    if (info.cue) parts.push("提示音=" + info.cue);
    if (info.error) parts.push("错误=" + info.error);
    if (info.inputDevice) parts.push("设备=" + info.inputDevice);
    return parts.length ? (" " + parts.join(" ")) : "";
  }

  function sessions() {
    try {
      const list = hub.list();
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  function findSession(id) {
    if (!id) return null;
    try {
      if (typeof hub.get === "function") {
        const found = hub.get(id);
        if (found) return found;
      }
    } catch (error) {
      /* 继续查列表 */
    }
    return sessions().find(function (item) { return item && item.id === id; }) || null;
  }

  function canPrompt(session) {
    if (!session) return false;
    const caps = session.capabilities;
    if (caps && Array.isArray(caps.control)) return caps.control.includes("prompt");
    // 兼容没有 capabilities 的旧快照：Claude Code 仍然是只读。
    return session.agent !== "claude-code";
  }

  function activeSessions() {
    return sessions().filter(function (item) { return item && item.id && byActive(item) && canPrompt(item); });
  }

  function titleOf(session) {
    return String((session && (session.title || session.id)) || "未命名会话");
  }

  function candidateText(list) {
    const active = activeSessions();
    return list.slice(0, maxCandidates).map(function (session) {
      const index = active.findIndex(function (item) { return item.id === session.id; });
      const head = index >= 0 ? (index + 1) + ". " : "";
      return head + titleOf(session);
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

  /** 0.2 的目标规则：焦点优先；没有焦点只自动选唯一的活跃会话；其它一律不猜。 */
  function resolveTarget(forcedId) {
    const focusId = forcedId !== undefined
      ? forcedId
      : (getTargetSessionId ? getTargetSessionId() : null);
    const active = activeSessions();

    if (focusId) {
      const found = findSession(focusId);
      if (found && !canPrompt(found)) {
        return {
          ok: false,
          action: "target-readonly",
          reply: "当前关注的会话仅观测，不能发送指令。",
          candidates: candidates(active),
        };
      }
      if (found) {
        return { ok: true, session: found, source: "focus", title: titleOf(found) };
      }
      return {
        ok: false,
        action: "target-offline",
        reply: "当前关注的会话已离线，未发送。"
          + (active.length ? "可选：" + candidateText(active) + "。" : "当前没有活跃会话。"),
        candidates: candidates(active),
      };
    }

    if (active.length === 1) {
      return { ok: true, session: active[0], source: "single-active", title: titleOf(active[0]) };
    }

    if (active.length === 0) {
      return {
        ok: false,
        action: "no-target",
        reply: "没有明确的发送目标：当前没有活跃会话，未发送。",
        candidates: [],
      };
    }

    return {
      ok: false,
      action: "ambiguous",
      reply: "有 " + active.length + " 个活跃会话，没有明确的发送目标，未发送。可选："
        + candidateText(active) + "。先说「切到第几个」再口述。",
      candidates: candidates(active),
    };
  }

  function buildDraft(text, target) {
    return buildDictationDraft({
      text,
      targetTitle: target && target.ok && target.title ? target.title : "",
    });
  }

  function targetInfo(target) {
    if (!target || !target.ok) return null;
    return { id: target.session.id, title: target.title, source: target.source };
  }

  function heardInfo(heard) {
    if (!heard) return null;
    return {
      text: String(heard.text || ""),
      confidence: typeof heard.confidence === "number" ? heard.confidence : null,
    };
  }

  async function safeSpeak(text) {
    if (typeof log.debug === "function") log.debug("语音口述: 播报「" + String(text) + "」");
    try {
      await speak(text);
    } catch (error) {
      logWarn("语音口述: 播报失败 " + (error && error.message ? error.message : String(error)));
    }
  }

  async function safePrepare() {
    if (!prepare) return null;
    try {
      return await prepare();
    } catch (error) {
      return { ok: false, error: "prepare-failed" };
    }
  }

  /** 结果先显示在浮层，再留一点时间让 UI 画出来，最后才播报。 */
  async function finish(reply, details) {
    emitEvent(Object.assign({ phase: "result", reply: reply }, details || {}));
    if (resultDelayMs > 0) await sleep(resultDelayMs);
    await safeSpeak(reply);
  }

  function buildResult(ok, action, reply, context) {
    const info = context || {};
    const target = targetInfo(info.target);
    const text = info.text === undefined ? "" : String(info.text);
    return {
      ok: ok,
      intent: DICTATION_INTENT,
      action: action,
      heard: info.heard || null,
      draft: info.text === undefined ? null : {
        text: text,
        chars: info.chars !== undefined ? info.chars : charsOf(text),
        targetTitle: target ? target.title : "",
      },
      target: target,
      candidates: (info.target && info.target.candidates) || null,
      reply: reply,
      error: ok ? undefined : action,
    };
  }

  async function fail(action, reply, context) {
    const result = buildResult(false, action, reply, context);
    logInfo("语音口述: 未发送 原因=" + action
      + (result.target ? " 目标=" + result.target.title : "")
      + (result.draft ? " 字数=" + result.draft.chars : ""));
    await finish(reply, {
      ok: false,
      action: action,
      target: result.target,
      candidates: result.candidates,
      chars: result.draft ? result.draft.chars : undefined,
      text: result.draft ? result.draft.text : undefined,
      error: action,
    });
    return result;
  }

  function validateHeard(heard) {
    if (!heard || !heard.ok) {
      const error = (heard && heard.error) || "listen-failed";
      if (error === "timeout" || error === "mic-silent" || error === "route-changed") {
        return { ok: false, action: "timeout", reply: "没有听到内容，未发送。" };
      }
      if (MIC_UNAVAILABLE_ERRORS.indexOf(error) !== -1) {
        return { ok: false, action: "mic-unavailable", reply: "麦克风不可用，未发送。请检查语音设置。" };
      }
      return { ok: false, action: "listen-failed", reply: "没听清，未发送。" };
    }
    const text = String(heard.text || "").trim();
    if (!text) return { ok: false, action: "empty", reply: "没有听清内容，未发送。" };
    if (heard.lowConfidence) return { ok: false, action: "low-confidence", reply: "听得不太确定，未发送。" };
    const chars = charsOf(text);
    if (chars > maxChars) {
      return {
        ok: false,
        action: "too-long",
        reply: "内容有 " + chars + " 个字，超过上限 " + maxChars + " 字，未发送。",
      };
    }
    return { ok: true, text: text, chars: chars };
  }

  async function recordDraft(isRetry) {
    let heard = null;
    const attempts = isRetry ? 1 : listenAttempts;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await safePrepare();
      if (isRetry) {
        await safeSpeak(attempt === 1 ? "请重新说你要交给 Agent 的内容。" : "没有听到，请等提示音再说一次。");
      } else if (attempt === 1) {
        await safeSpeak(DICTATE_PROMPT);
      } else {
        await safeSpeak("没有听到，请等提示音再说一次。");
      }
      if (listenDelayMs > 0) await sleep(listenDelayMs);

      emitEvent({ phase: "listening", stage: isRetry ? "retry" : "record", attempt: attempt });
      const started = now();
      heard = await listenOnce({
        io: { listen: listen },
        timeoutMs: timeoutMs,
        minConfidence: minConfidence,
        silence: silence,
        maxSeconds: maxSeconds,
        threshold: threshold,
      });

      if (heard.ok) {
        const text = String(heard.text || "");
        logInfo("语音口述: 识别完成 第" + attempt + "次 耗时=" + elapsed(started) + "ms 字数="
          + charsOf(text.trim()) + " 置信度=" + confidenceText(heard.confidence)
          + recordText(heard.record, null));
        emitEvent({
          phase: "heard",
          stage: isRetry ? "retry" : "record",
          attempt: attempt,
          text: text,
          confidence: heard.confidence,
          lowConfidence: heard.lowConfidence,
          chars: charsOf(text.trim()),
        });
        return heard;
      }

      logInfo("语音口述: 识别失败 第" + attempt + "次 错误=" + (heard.error || "unknown")
        + " 耗时=" + elapsed(started) + "ms" + recordText(null, heard.detail));
      emitEvent({
        phase: "listen-error",
        stage: isRetry ? "retry" : "record",
        attempt: attempt,
        error: heard.error,
        detail: heard.detail || null,
      });
      if (RETRYABLE_LISTEN_ERRORS.indexOf(heard.error) === -1) return heard;
    }
    return heard;
  }

  async function sendDraft(context) {
    const target = context.target;
    const text = context.text;
    const chars = context.chars;
    const heard = context.heard;
    const draft = context.draft;

    emitEvent({
      phase: "sending",
      target: targetInfo(target),
      chars: chars,
    });
    const started = now();
    let sent;
    try {
      if (typeof sendPrompt !== "function") throw new Error("sendPrompt 未注入");
      sent = await sendPrompt(target.session.id, text);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      const reply = "发送失败：" + message + "。未重试，草稿保留在浮层。";
      logInfo("语音口述: 未发送 原因=send-failed 目标=" + target.title + "(" + target.session.id + ") 错误=" + message);
      const result = buildResult(false, "send-failed", reply, context);
      await finish(reply, {
        ok: false,
        action: "send-failed",
        target: result.target,
        chars: chars,
        text: text,
        error: "send-failed",
      });
      return result;
    }

    if (sent && sent.ok === false) {
      const reply = "发送被拒绝，未重试，草稿保留在浮层。";
      logInfo("语音口述: 未发送 原因=send-rejected 目标=" + target.title + "(" + target.session.id + ")");
      const result = buildResult(false, "send-rejected", reply, context);
      await finish(reply, {
        ok: false,
        action: "send-rejected",
        target: result.target,
        chars: chars,
        text: text,
        error: "send-rejected",
      });
      return result;
    }

    const reply = "已发送给「" + target.title + "」。";
    logInfo("语音口述: 已发送 目标=" + target.title + "(" + target.session.id + ") 字数=" + chars
      + " 耗时=" + elapsed(started) + "ms");
    await finish(reply, {
      ok: true,
      action: "sent",
      target: targetInfo(target),
      chars: chars,
      text: text,
    });
    const result = buildResult(true, "sent", reply, context);
    result.draft = { text: text, chars: chars, prompt: draft && draft.prompt, targetTitle: target.title };
    return result;
  }

  async function runFromMicrophone() {
    const started = now();
    logInfo("语音口述: 开始监听 超时=" + timeoutMs + "ms 静音=" + silence + "s 最长=" + maxSeconds
      + "s 最低置信度=" + minConfidence + " 最多尝试=" + listenAttempts + " 次");
    emitEvent({ phase: "start", mode: "dictate" });

    if (typeof listen !== "function") {
      return fail("no-listener", "语音输入不可用，未发送。", {});
    }

    // 目标在本次口述开始时捕获：录制、重说、确认期间切换关注会话都不改变目标。
    const target = resolveTarget();
    if (target.ok) {
      logInfo("语音口述: 目标会话=" + target.title + "(" + target.session.id + ") 来源=" + target.source);
    } else {
      logInfo("语音口述: 目标会话=- 来源=none 原因=" + target.action);
    }

    let heard = await recordDraft(false);
    let checked = validateHeard(heard);
    let text = checked.ok ? checked.text : String((heard && heard.text) || "").trim();
    let chars = checked.ok ? checked.chars : charsOf(text);
    let draft = buildDraft(text, target);

    // 目标事件先于草稿：浮层先把「发给谁」固定下来，再显示正文。
    emitEvent({
      phase: "target",
      ok: target.ok,
      target: targetInfo(target),
      source: target.ok ? target.source : null,
      candidates: target.ok ? null : (target.candidates || null),
      reply: target.ok ? null : target.reply,
    });
    emitEvent({
      phase: "draft",
      ok: checked.ok,
      text: text,
      chars: chars,
      target: targetInfo(target),
      prompt: target.ok ? draft.prompt : null,
      error: checked.ok ? null : checked.action,
    });
    logInfo("语音口述: 草稿 目标=" + (target.ok ? target.title : "-")
      + " 字数=" + chars + (checked.ok ? "" : " 未发送原因=" + checked.action));

    if (!checked.ok) {
      return fail(checked.action, checked.reply, { heard: heardInfo(heard), text: text, chars: chars, target: target });
    }
    if (!target.ok) {
      return fail(target.action, target.reply, { heard: heardInfo(heard), text: text, chars: chars, target: target });
    }

    logInfo("语音口述: 需要确认 目标=" + target.title + " 字数=" + chars
      + " 回读=「" + clipText(draft.prompt, LOG_PREVIEW) + "」");
    emitEvent({
      phase: "confirm",
      prompt: draft.prompt,
      text: text,
      chars: chars,
      target: targetInfo(target),
    });
    await safeSpeak(draft.prompt);

    let confirmAttempt = 0;
    let retried = false;
    while (confirmAttempt < confirmAttempts) {
      confirmAttempt += 1;
      await safePrepare();
      if (confirmAttempt > 1) await safeSpeak("没听清，请说确认发送，或者说取消。");
      if (listenDelayMs > 0) await sleep(listenDelayMs);
      emitEvent({ phase: "listening", stage: "confirm", attempt: confirmAttempt });

      const confirmStarted = now();
      const confirmation = await listenOnce({
        io: { listen: listen },
        timeoutMs: confirmTimeoutMs,
        minConfidence: minConfidence,
      });
      logInfo("语音口述: 确认尝试 第" + confirmAttempt + "次 耗时=" + elapsed(confirmStarted) + "ms"
        + (confirmation.ok
          ? (" 文本=「" + clipText(confirmation.text, LOG_PREVIEW) + "」 置信度=" + confidenceText(confirmation.confidence))
          : (" 错误=" + confirmation.error))
        + recordText(confirmation.ok ? confirmation.record : null, confirmation.detail));

      if (!confirmation.ok) {
        emitEvent({
          phase: "confirm-error",
          attempt: confirmAttempt,
          error: confirmation.error,
          detail: confirmation.detail || null,
        });
        if (confirmation.error === "timeout") {
          return fail("timeout", "没有听到确认，未发送。", {
            heard: heardInfo(heard), text: text, chars: chars, target: target,
          });
        }
        if (confirmAttempt >= confirmAttempts) {
          return fail("listen-failed", "没听清，未发送。", {
            heard: heardInfo(heard), text: text, chars: chars, target: target,
          });
        }
        continue;
      }

      if (!confirmation.text.trim() || confirmation.lowConfidence) {
        const reason = confirmation.lowConfidence ? "low-confidence" : "empty";
        logInfo("语音口述: 确认输入 文本=「" + clipText(confirmation.text, LOG_PREVIEW) + "」 判定=" + reason);
        emitEvent({
          phase: "confirm-heard",
          attempt: confirmAttempt,
          text: confirmation.text,
          confidence: confirmation.confidence,
          confirmed: false,
          intent: reason,
        });
        if (confirmAttempt >= confirmAttempts) {
          return fail(reason, "没听清，未发送。", {
            heard: heardInfo(heard), text: text, chars: chars, target: target,
          });
        }
        continue;
      }

      const replyIntent = parseReply(confirmation.text).intent;
      const confirmed = isDictationConfirm(confirmation.text);
      emitEvent({
        phase: "confirm-heard",
        attempt: confirmAttempt,
        text: confirmation.text,
        confidence: confirmation.confidence,
        confirmed: confirmed,
        intent: replyIntent,
        strict: confirmed,
      });
      logInfo("语音口述: 确认输入 文本=「" + clipText(confirmation.text, LOG_PREVIEW) + "」 判定="
        + (confirmed ? "confirm" : replyIntent));

      if (replyIntent === INTENT.CANCEL || replyIntent === INTENT.REJECT) {
        return fail("cancel", "已取消，未发送。", {
          heard: heardInfo(heard), text: text, chars: chars, target: target,
        });
      }

      if (replyIntent === INTENT.RETRY) {
        if (retried) {
          return fail("retry-limit", "已经重说过一次，未发送。", {
            heard: heardInfo(heard), text: text, chars: chars, target: target,
          });
        }
        retried = true;
        logInfo("语音口述: 重说 丢弃草稿 目标=" + target.title + " 字数=" + chars);
        emitEvent({ phase: "retry" });
        await safeSpeak("已丢弃，请重新说。");

        heard = await recordDraft(true);
        checked = validateHeard(heard);
        text = checked.ok ? checked.text : String((heard && heard.text) || "").trim();
        chars = checked.ok ? checked.chars : charsOf(text);
        draft = buildDraft(text, target);
        emitEvent({
          phase: "draft",
          ok: checked.ok,
          text: text,
          chars: chars,
          target: targetInfo(target),
          prompt: checked.ok ? draft.prompt : null,
          error: checked.ok ? null : checked.action,
          retried: true,
        });
        logInfo("语音口述: 草稿 目标=" + target.title + " 字数=" + chars
          + (checked.ok ? " 重说后" : " 未发送原因=" + checked.action));
        if (!checked.ok) {
          return fail(checked.action, checked.reply, {
            heard: heardInfo(heard), text: text, chars: chars, target: target,
          });
        }
        emitEvent({
          phase: "confirm",
          prompt: draft.prompt,
          text: text,
          chars: chars,
          target: targetInfo(target),
        });
        await safeSpeak(draft.prompt);
        confirmAttempt = 0;
        continue;
      }

      if (confirmed) {
        return sendDraft({
          target: target,
          text: text,
          chars: chars,
          heard: heardInfo(heard),
          draft: draft,
        });
      }

      if (confirmAttempt >= confirmAttempts) {
        return fail("no-confirm", "没有听到「确认发送」，未发送。", {
          heard: heardInfo(heard), text: text, chars: chars, target: target,
        });
      }
    }

    return fail("no-confirm", "没有听到「确认发送」，未发送。", {
      heard: heardInfo(heard), text: text, chars: chars, target: target,
    });
  }

  return {
    runFromMicrophone,
    resolveTarget,
    buildDraft,
    isDictationConfirm,
    maxChars: function () { return maxChars; },
  };
}
