import { INTENT, digitSequence, matchesNonce, parseReply } from "./text.mjs";

export const OUTCOME = Object.freeze({
  ALLOW: "allow",
  REJECT: "reject",
  CANCEL: "cancel",
  RETRY: "retry",
  TIMEOUT: "timeout",
  DEFER: "defer",
});

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
    let result = null;
    try {
      result = await io.listen({ timeoutMs });
    } catch (error) {
      result = { ok: false, error: "listen-failed:" + (error && error.message ? error.message : String(error)) };
    }

    if (!result || result.ok === false) {
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

    if (typeof result.confidence === "number" && result.confidence >= 0 && result.confidence < minConfidence) {
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
      if (reply.intent === INTENT.CONFIRM) {
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
