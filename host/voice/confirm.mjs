import { INTENT, digitSequence, isDictationConfirm, matchesNonce, parseReply } from "./text.mjs";

export const OUTCOME = Object.freeze({
  ALLOW: "allow",
  REJECT: "reject",
  CANCEL: "cancel",
  RETRY: "retry",
  TIMEOUT: "timeout",
  DEFER: "defer",
});

/**
 * 只「听一次」：开麦、VAD、ASR，返回文本与置信度。
 *
 * 审批确认与 P1 语音命令共用这一层，避免两处各写一套录音/异常处理。
 * 不在这里做任何业务判断：不解析意图、不决定重试。
 *
 * io = { listen({ timeoutMs }) -> { ok, text, confidence, error } }
 */
export async function listenOnce(options) {
  const opts = options || {};
  const io = opts.io;
  if (!io || typeof io.listen !== "function") throw new Error("listenOnce 需要 io.listen");
  const timeoutMs = opts.timeoutMs || 15000;
  const minConfidence = typeof opts.minConfidence === "number" ? opts.minConfidence : 0.35;
  const prompt = String(opts.prompt || "");
  // 口述需要更长的断句静音与最长录音时间；审批/命令不传这些字段，保持原有默认。
  const listenInput = { timeoutMs, prompt };
  if (opts.silence !== undefined) listenInput.silence = opts.silence;
  if (opts.maxSeconds !== undefined) listenInput.maxSeconds = opts.maxSeconds;
  if (opts.threshold !== undefined) listenInput.threshold = opts.threshold;

  let result = null;
  try {
    result = await io.listen(listenInput);
  } catch (error) {
    result = { ok: false, error: "listen-failed:" + (error && error.message ? error.message : String(error)) };
  }

  if (!result || result.ok === false) {
    return {
      ok: false,
      error: (result && result.error) || "listen-failed",
      text: "",
      confidence: null,
      lowConfidence: false,
      // 录音失败时把 helper 诊断带回去：host 日志能区分没权限、没音频、路由变化。
      detail: result || null,
    };
  }

  const text = String(result.text || "");
  const confidence = typeof result.confidence === "number" ? result.confidence : null;
  return {
    ok: true,
    text,
    confidence,
    lowConfidence: confidence !== null && confidence >= 0 && confidence < minConfidence,
    record: result.record || null,
  };
}

/**
 * 两段式语音确认：先念草稿，再听回话，只有明确同意才返回 ALLOW。
 *
 * io = { speak(text), listen({ timeoutMs }) -> { ok, text, confidence, error } }
 * 任何异常、超时、低置信度、听不懂，都不会返回 ALLOW。
 */
export async function runVoiceConfirm(options) {
  const opts = options || {};
  const io = opts.io;
  const draft = opts.draft;
  if (!io || typeof io.speak !== "function" || typeof io.listen !== "function") {
    throw new Error("runVoiceConfirm 需要 io.speak 与 io.listen");
  }
  if (!draft || !draft.prompt) throw new Error("runVoiceConfirm 需要带 prompt 的 draft");

  const nonce = String(opts.nonce || draft.nonce || "");
  const timeoutMs = opts.timeoutMs || 15000;
  const maxAttempts = opts.maxAttempts || 3;
  const minConfidence = typeof opts.minConfidence === "number" ? opts.minConfidence : 0.35;
  const log = opts.log || function () {};
  const heard = [];

  async function say(text) {
    log({ type: "tts", text });
    await io.speak(text);
  }

  await say(draft.prompt);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isLast = attempt >= maxAttempts;
    const finalize = async function (message) {
      await say(message + "，已结束语音确认，请用手机或终端处理。");
      return { outcome: OUTCOME.DEFER, attempts: attempt, heard };
    };
    // 审批与命令共用同一次「听」：异常在这里归一成 ok:false，业务语义留在下面。
    const result = await listenOnce({ io, timeoutMs, minConfidence });

    if (!result.ok) {
      if (result && result.error === "timeout") {
        await say("没有听到回应，已结束语音确认。");
        return { outcome: OUTCOME.TIMEOUT, attempts: attempt, heard };
      }
      const unavailable = ["mic-denied", "speech-denied", "capture-failed", "open-failed", "no-meta", "engine-failed"];
      if (result && unavailable.indexOf(result.error) !== -1) {
        log({ type: "mic-unavailable", error: result.error });
        await say("麦克风不可用，已结束语音确认，请用手机或终端处理。");
        return { outcome: OUTCOME.DEFER, attempts: attempt, heard, error: result.error };
      }
      log({ type: "asr-error", error: result && result.error });
      await say("没听清，请再说一遍。");
      continue;
    }

    const text = String(result.text || "");
    if (!text.trim()) {
      if (isLast) return finalize("没听清");
      await say("没听清，请再说一遍。");
      continue;
    }

    if (result.lowConfidence) {
      log({ type: "asr-low-confidence", attempt, text, confidence: result.confidence, expected: draft.kind === "approval" ? nonce : undefined });
      if (isLast) return finalize("没听清");
      await say("没听清，请再说一遍。");
      continue;
    }

    const reply = parseReply(text);
    heard.push({ attempt, text, intent: reply.intent, confidence: result.confidence });
    log({
      type: "asr",
      attempt,
      text,
      intent: reply.intent,
      confidence: result.confidence,
      expected: draft.kind === "approval" ? nonce : undefined,
    });

    if (reply.intent === INTENT.REJECT) {
      await say("已拒绝。");
      return { outcome: OUTCOME.REJECT, attempts: attempt, heard };
    }
    if (reply.intent === INTENT.CANCEL) {
      await say("已取消。");
      return { outcome: OUTCOME.CANCEL, attempts: attempt, heard };
    }
    if (reply.intent === INTENT.RETRY) {
      await say("已丢弃，请重新说。");
      return { outcome: OUTCOME.RETRY, attempts: attempt, heard };
    }
    if (reply.intent === INTENT.REPEAT) {
      await say(draft.prompt);
      continue;
    }

    if (draft.kind === "approval") {
      if (matchesNonce(text, nonce)) {
        await say("已批准。");
        return { outcome: OUTCOME.ALLOW, attempts: attempt, heard };
      }
      const got = digitSequence(text);
      if (got) {
        if (isLast) return finalize("口令不对");
        await say("口令不对。请复述：" + nonce.split("").join(" ") + "。");
        continue;
      }
      if (reply.intent === INTENT.CONFIRM) {
        if (isLast) return finalize("没有收到口令");
        await say("请复述口令：" + nonce.split("").join(" ") + "。");
        continue;
      }
      if (isLast) return finalize("没听懂");
      await say("没听懂。请复述口令，或者说取消。");
      continue;
    }

    if (draft.kind === "dictation") {
      // 口述专用严格匹配：泛化的「同意」「确定」「好」不能发送任务。
      if (isDictationConfirm(text)) {
        await say("已发送。");
        return { outcome: OUTCOME.ALLOW, attempts: attempt, heard };
      }
      if (isLast) return finalize("没听懂");
      await say("没听懂。请说确认发送，或者说取消。");
      continue;
    }

    throw new Error("未知的草稿类型: " + draft.kind);
  }

  await say("多次没听清，已结束语音确认，请用手机或终端处理。");
  return { outcome: OUTCOME.DEFER, attempts: maxAttempts, heard };
}
