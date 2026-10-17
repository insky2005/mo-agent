import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 用脚本里的假转写驱动确认流程，不碰麦克风。 */
export function createScriptedListener(script, options) {
  const queue = (script || []).slice();
  const log = (options && options.log) || function () {};
  return async function listen() {
    if (!queue.length) return { ok: false, error: "timeout" };
    const next = queue.shift();
    const result = typeof next === "string" ? { ok: true, text: next, confidence: 1 } : next;
    log({ type: "asr-simulated", text: result && result.text });
    return result;
  };
}

/** 麦克风录制：交给常驻 helper，VAD 断句后它自己落 wav。 */
export function createMicCapture(options) {
  const opts = options || {};
  const client = opts.client;
  if (!client || typeof client.record !== "function") {
    throw new Error("createMicCapture 需要 helper client");
  }

  return async function capture(input) {
    const timeoutMs = (input && input.timeoutMs) || opts.timeoutMs || 15000;
    const result = await client.record({ timeoutMs });
    if (!result || !result.ok) return result || { ok: false, error: "capture-failed" };
    return { ok: true, raw: result.file, seconds: result.seconds };
  };
}

/** 麦克风 → 16k wav → whisper。 */
export function createVoiceListener(options) {
  const opts = options || {};
  const capture = opts.capture;
  const transcribe = opts.transcribe;
  const log = opts.log || function () {};

  return async function listen(input) {
    const captured = await capture(input);
    if (!captured || !captured.ok) return captured || { ok: false, error: "capture-failed" };
    const wav16 = captured.raw.replace(/\.wav$/i, "-16k.wav");
    await execFileP("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", captured.raw, wav16], {
      timeout: 30000,
    });
    const result = await transcribe(wav16);
    await fs.unlink(captured.raw).catch(function () {});
    await fs.unlink(wav16).catch(function () {});
    log({ type: "listen-done", text: result && result.text });
    return result;
  };
}
