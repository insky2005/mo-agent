import fs from "node:fs";
import { buildApprovalDraft, makeNonce } from "./text.mjs";
import { OUTCOME, runVoiceConfirm } from "./confirm.mjs";
import { createSpeaker } from "./tts.mjs";
import { createWhisperTranscriber } from "./whisper.mjs";
import { createMicCapture, createVoiceListener } from "./io.mjs";
import { createHelperClient } from "./helper-client.mjs";
import { DECISION } from "../../approvals/broker.mjs";

/**
 * 语音只对「明确的放行/拒绝」落决策。
 * 超时、取消、麦克风不可用都返回 null——把 pending 留给手机或 broker 超时，
 * 不能因为语音没听清就提前把请求关掉。
 */
export function decisionForOutcome(outcome) {
  if (outcome === OUTCOME.ALLOW) return DECISION.ALLOW_ONCE;
  if (outcome === OUTCOME.REJECT) return DECISION.REJECT_ONCE;
  return null;
}

export function parseMicStatus(text) {
  const match = /rawValue:\s*(\d+)/.exec(String(text == null ? "" : text));
  return match ? Number(match[1]) : null;
}

export function targetOf(payload) {
  const input = (payload && payload.toolInput) || {};
  return String(
    input.command || input.file_path || input.path || input.url || input.query ||
    (payload && payload.title) || ""
  );
}

/**
 * 启动时检查依赖与麦克风权限，避免每个授权都白等 45 秒。
 * 权限要按 .app 主体查：helper 由 open 启动，命令行 selftest 看不到它的授权。
 */
export async function checkVoiceReady(options) {
  const opts = options || {};
  const files = [
    ["语音桥", opts.bridge],
    ["whisper", opts.whisperBinary],
    ["模型", opts.model],
  ];
  for (const [label, file] of files) {
    if (!file || !fs.existsSync(file)) return { ready: false, reason: "缺少" + label };
  }

  let parsed = null;
  try {
    const selftest = typeof opts.selftest === "function"
      ? opts.selftest
      : function () {
        const client = opts.client || createHelperClient({ app: opts.bridge, log: opts.log });
        return client.selftest();
      };
    parsed = await selftest();
  } catch (error) {
    return { ready: false, reason: "语音桥自检失败" };
  }

  if (!parsed || parsed.ok === false) {
    return { ready: false, reason: "语音桥不可用（" + ((parsed && parsed.error) || "unknown") + "）" };
  }

  const micStatus = parseMicStatus(parsed.micAuthorization);
  if (micStatus === 1 || micStatus === 2) {
    return { ready: false, reason: "麦克风权限被拒绝", micStatus };
  }
  return { ready: true, micStatus };
}

export function createVoiceChannel(options) {
  const opts = options || {};
  const log = opts.log || { info: function () {}, warn: function () {} };
  // 适配层要的是「收一个事件的函数」，host 的 logger 是对象，先转一道。
  const eventLog = opts.eventLog || function (event) {
    if (typeof log.debug === "function") log.debug(JSON.stringify(event));
  };
  const say = opts.speaker || createSpeaker({ dryRun: opts.dryRun, log: eventLog });
  const client = opts.client || (opts.listener ? null : createHelperClient({ app: opts.bridge, log }));
  const listen = opts.listener || createVoiceListener({
    capture: createMicCapture({ client }),
    transcribe: createWhisperTranscriber({ binary: opts.whisperBinary, model: opts.model, log: eventLog }),
    log: eventLog,
  });
  const nonceFactory = opts.nonceFactory || makeNonce;
  const timeoutMs = opts.timeoutMs || 15000;
  const maxAttempts = opts.maxAttempts || 3;

  let busy = false;
  let stopped = false;

  /**
   * 同一时间只处理一路语音：审批确认、语音测试、语音命令都从这里排队，
   * 避免两段录音/播报叠在一起。命令路由也复用它做互斥。
   */
  /** 提前拉起 helper / 检查麦克风权限，避免用户听完提示才开始冷启动。 */
  async function prepare() {
    if (!client) return { ok: true, simulated: true };
    const started = Date.now();
    try {
      const result = await client.selftest();
      return Object.assign({ ms: Date.now() - started }, result || {});
    } catch (error) {
      return {
        ok: false,
        error: "selftest-failed",
        message: String(error && error.message ? error.message : error),
        ms: Date.now() - started,
      };
    }
  }

  async function exclusive(task) {
    if (stopped) return { outcome: "stopped" };
    if (busy) return { outcome: "busy" };
    busy = true;
    try {
      return await task();
    } finally {
      busy = false;
    }
  }

  function handle(item) {
    return exclusive(async function () {
      const payload = (item && item.payload) || {};
      const nonce = String(nonceFactory(4));
      const draft = buildApprovalDraft({
        agentLabel: payload.agentLabel || payload.agent,
        toolName: payload.toolName,
        title: payload.title,
        target: targetOf(payload),
        nonce,
      });
      log.info("语音询问: " + (payload.toolName || "approval") + "，口令 " + nonce);
      const warmed = await prepare();
      if (warmed && warmed.ok === false) log.warn("语音预热失败: " + (warmed.error || "unknown"));
      const result = await runVoiceConfirm({
        draft,
        io: { speak: say, listen },
        nonce,
        timeoutMs,
        maxAttempts,
        log: eventLog,
      });
      log.info("语音结果: " + result.outcome);
      return result;
    });
  }

  function test() {
    return exclusive(async function () {
      const nonce = String(nonceFactory(4));
      const draft = {
        kind: "approval",
        prompt: "语音测试。听到提示音后，请复述口令：" + nonce.split("").join(" ") + "。",
        nonce,
      };
      log.info("语音测试，口令 " + nonce);
      const warmed = await prepare();
      if (warmed && warmed.ok === false) log.warn("语音预热失败: " + (warmed.error || "unknown"));
      const result = await runVoiceConfirm({
        draft,
        io: { speak: say, listen },
        nonce,
        timeoutMs,
        maxAttempts,
        log: eventLog,
      });
      log.info("语音测试结果: " + result.outcome);
      return result;
    });
  }

  return {
    handle,
    test,
    // P1 语音命令复用同一条录音/ASR 链路，并和审批确认共享互斥。
    listen,
    prepare,
    runExclusive: exclusive,
    isBusy: function () { return busy; },
    stop: function () {
      stopped = true;
      if (client) client.shutdown().catch(function () {});
    },
  };
}
