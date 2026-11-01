import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { createRotatingSink } from "./log-file.mjs";
import { Hub } from "../core/hub.mjs";
import { Notifier } from "../core/notify.mjs";
import { loadMobileMode, loadNotifyChannels } from "./notify-webhook.mjs";
import { createDingTalkBot, loadDingTalkBotConfig } from "./dingtalk-bot.mjs";
import { createDingTalkSetup } from "./dingtalk-setup.mjs";
import { createPushTokenStore } from "./push-tokens.mjs";
import { ensureNotifyConfig } from "./notify-config.mjs";
import { DshClient } from "../adapters/dsh.mjs";
import { createPiControl } from "../adapters/pi-control.mjs";
import { createAdapters, loadProfiles } from "../adapters/registry.mjs";
import { ApprovalBroker } from "../approvals/broker.mjs";
import { createDecisionRouter } from "./decisions.mjs";
import { checkVoiceReady, createVoiceChannel, decisionForOutcome } from "./voice/channel.mjs";
import { createScriptedListener } from "./voice/io.mjs";
import { makeNonce } from "./voice/text.mjs";
import { createSpeaker } from "./voice/tts.mjs";
import { createVoiceNotifier } from "./voice/notifier.mjs";
import { createCommandExecutor } from "./voice/commands.mjs";
import { createDictationRunner } from "./voice/dictate.mjs";
import { createHelperClient } from "./voice/helper-client.mjs";
import { createMoAgentServer, localIPv4List } from "./http.mjs";
import { createHooksManager } from "./agent-hooks.mjs";
import { handlePairRoutes } from "./pair-http.mjs";
import { handleSettingsRoutes } from "./settings-page.mjs";
import { PairingManager, buildPairPayload } from "./pairing.mjs";
import QRCode from "qrcode";
import { scanProcesses } from "../adapters/process-scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// 打包成单文件运行时时，壳会通过 MO_AGENT_ROOT 指定运行时目录；
// 开发态则回退到源码目录。
const root = process.env.MO_AGENT_ROOT ? path.resolve(process.env.MO_AGENT_ROOT) : path.resolve(here, "..");
const webDir = path.join(root, "app", "web");
// APK 有两个来源：打包进运行时的（桌面分发版），或用户用 scripts/fetch-apk.sh 下到本机的。
// 前者优先；都没有时 /app.apk 会 404 并提示去下载。
const bundledApkPath = path.join(root, "app", "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const fetchedApkPath = path.join(os.homedir(), ".mo-agent", "app.apk");
const apkPath = fs.existsSync(bundledApkPath) ? bundledApkPath : fetchedApkPath;
// host 自己写这份日志并在 5MB 处轮转（.1 -> .3），桌面壳不再重定向 stdout/stderr。
// 桌面端的启动/退出信息单独写 desktop.log，避免两个进程抢同一个文件。
const logFile = process.env.MO_AGENT_LOG_FILE || path.join(os.homedir(), "Library", "Logs", "mo-agent", "host.log");
// 已配对设备令牌落盘，host 重启后不丢（否则每次「重启服务」都要重新配对）
const deviceFile = process.env.MO_AGENT_DEVICE_FILE || path.join(os.homedir(), ".mo-agent", "devices.json");
// 本机会话凭证：令牌跨 host 重启复用，避免书签/管理 Cookie 每次重启失效。
const sessionFile = path.join(os.homedir(), ".mo-agent", "session.json");

const config = loadConfig(process.argv);
config.transcriptPollMs = config.transcriptPollMs || 2000;
config.approvalTimeoutMs = config.approvalTimeoutMs || 120000;
const log = createLogger(config.logLevel, createRotatingSink({ file: logFile }));

const hub = new Hub({ log, historySize: config.historySize });
// 统一通知路由：把授权/提问/完成/失败翻译成 notify 事件，客户端只认这一条
const notifier = new Notifier({ hub, log });
const pushTokens = createPushTokenStore({ log });
// 首次启动自动写默认通知配置，用户（含其他安装者）不用手写 ~/.mo-agent/notify.json
const notifyDefaults = process.env.MO_AGENT_NOTIFY_DEFAULTS
  || (fs.existsSync(path.join(root, "host", "notify-defaults.json"))
    ? path.join(root, "host", "notify-defaults.json")
    : path.join(root, "notify-defaults.json"));
ensureNotifyConfig({ log, defaults: notifyDefaults });
for (const channel of loadNotifyChannels({ log, mobileMode: loadMobileMode({ log }), getPushTokens: () => pushTokens.list() })) {
  notifier.register(channel);
  log.info("已注册通知通道: " + channel.name);
}
notifier.start();

function readPersistedLocalToken() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    return typeof parsed.token === "string" && parsed.token.length >= 16 ? parsed.token : "";
  } catch (error) {
    return "";
  }
}

const localToken = process.env.MO_AGENT_LOCAL_TOKEN
  || readPersistedLocalToken()
  || randomBytes(24).toString("base64url");
// profiles 是运行时从磁盘读的，打包成单文件后必须显式指向运行时目录
const profiles = loadProfiles(path.join(root, "adapters", "profiles"));
// Agent hook 配置管理：设置页 / CLI 共用，只写自己认识的 hook，改前备份
const hooksManager = createHooksManager({ root, profiles, home: os.homedir(), log });

// L1：进程发现（独立于会话观测，唯一能覆盖任意 Agent 的手段）
const procState = { items: [] };
const processes = { list: () => procState.items };
async function rescan() {
  try {
    procState.items = await scanProcesses(profiles);
  } catch (error) {
    procState.items = [];
  }
}
rescan();
const procTimer = setInterval(rescan, 5000);

// 语音确认（可选）：环境变量或 ~/.mo-agent/voice.json（桌面托盘勾选）开启。
// 分发包把桥/whisper/模型放在 runtime/voice 下，开发态回退到 .build。
function firstExisting(candidates, fallback) {
  for (const file of candidates) {
    try {
      if (file && fs.existsSync(file)) return file;
    } catch (error) {
      /* 忽略 */
    }
  }
  return fallback;
}

function readVoiceConfig() {
  try {
    const file = path.join(os.homedir(), ".mo-agent", "voice.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && parsed.enabled === true;
  } catch (error) {
    return false;
  }
}

function voiceRuntimeEnabled() {
  return process.env.MO_AGENT_VOICE === "1"
    || (process.env.MO_AGENT_VOICE !== "0" && readVoiceConfig());
}
const voiceRoot = path.join(root, "voice");
const voiceSmallModel = firstExisting([
  path.join(voiceRoot, "models", "ggml-small-q8_0.bin"),
  path.join(root, ".build", "models", "ggml-small-q8_0.bin"),
], "");
const voiceBaseModel = firstExisting([
  path.join(voiceRoot, "models", "ggml-base.bin"),
  path.join(root, ".build", "models", "ggml-base.bin"),
], "");
const voiceModel = process.env.MO_AGENT_WHISPER_MODEL || voiceSmallModel || voiceBaseModel;
const voicePaths = {
  bridge: process.env.MO_AGENT_VOICE_BRIDGE || firstExisting([
    path.join(voiceRoot, "mo-agent 语音.app", "Contents", "MacOS", "mo-voice-bridge"),
    path.join(root, ".build", "mo-agent 语音.app", "Contents", "MacOS", "mo-voice-bridge"),
  ], path.join(voiceRoot, "mo-agent 语音.app", "Contents", "MacOS", "mo-voice-bridge")),
  whisperBinary: process.env.MO_AGENT_WHISPER_BIN || firstExisting([
    path.join(voiceRoot, "whisper", "bin", "whisper-cli"),
    path.join(root, ".build", "bin", "whisper-cli"),
  ], path.join(voiceRoot, "whisper", "bin", "whisper-cli")),
  model: voiceModel,
};
// 授权草稿与 critical 播报共用同一个串行 speaker，避免两句话叠在一起。
const voiceEventLog = function (event) {
  const type = event && event.type;
  const attempt = event && event.attempt ? ("第 " + event.attempt + " 次 ") : "";
  const confidence = event && typeof event.confidence === "number" ? event.confidence.toFixed(2) : "-";
  const expected = event && event.expected ? (" 期望口令=" + event.expected) : "";

  if (type === "asr") {
    log.info(attempt + "语音输入: 「" + (event.text || "") + "」 意图=" + (event.intent || "?") + " 置信度=" + confidence + expected);
    return;
  }
  if (type === "asr-low-confidence") {
    log.info(attempt + "语音输入置信度低: 「" + (event.text || "") + "」 置信度=" + confidence + expected);
    return;
  }
  if (type === "mic-unavailable" || type === "asr-error") {
    log.warn(attempt + "语音输入失败: " + JSON.stringify(event));
    return;
  }
  if (typeof log.debug === "function") log.debug(JSON.stringify(event));
};
let voiceSpeaker = null;
// 常驻 helper：open 启动一次，之后所有命令走本地 socket。
let voiceClient = null;
let voice = null;
let voiceStatus = "未启用";
let voiceCommands = null;
let dictateRunner = null;
let voiceNotifierChannel = null;
let voiceReloadPromise = Promise.resolve();

async function testVoice() {
  if (!voice) return { ok: false, error: "voice-disabled" };
  // 语音测试也从浮层按钮触发：广播与命令/口述一致的开始/结果/结束事件。
  broadcastVoiceEvent({ phase: "start", mode: "test", intent: "test" });
  const started = Date.now();
  const result = await voice.test();
  const ok = !!(result && result.outcome === "allow");
  const outcome = (result && (result.outcome || result.error)) || "unknown";
  broadcastVoiceEvent({
    phase: "result",
    ok: ok,
    intent: "test",
    action: outcome,
    reply: ok ? "语音测试完成，结果 allow。" : "语音测试结束，结果 " + outcome + "。",
  });
  broadcastVoiceEvent({ phase: "done", ok: ok, intent: "test" });
  log.info("语音测试: 请求结束 耗时=" + (Date.now() - started) + "ms ok=" + ok);
  return Object.assign({ ok: true }, result);
}

// 远程批准中枢（语音只是另一个决策端）
const runtime = {};
let dingtalkBot = null;
const pairing = new PairingManager({ log, ttlMs: config.qrTtlMs || 5 * 60 * 1000 });

// 手机/钉钉/语音发来的决定统一走这里：先 broker，再 DSH 原生待办。
let decisionRouter = null;
const routeDecision = (id, decision, extra) => (decisionRouter
  ? decisionRouter.decide(id, decision, extra)
  : broker.decide(id, decision, extra));

const broker = new ApprovalBroker({
  hub,
  log,
  timeoutMs: config.approvalTimeoutMs,
  // 静音时语音不再算作「在线决策端」：没有手机就直接交回终端，不白等。
  isClientConnected: () => (runtime.clientCount ? runtime.clientCount() > 0 : false)
    || (!!dingtalkBot && dingtalkBot.isAvailable())
    || (!!voice && !(voiceCommands && voiceCommands.isMuted())),
  // 有配对过推送设备时，App 可能正被通知叫醒：先等一小段时间再决定是否交回终端。
  noClientGraceMs: config.approvalNoClientGraceMs,
  hasRemoteClient: () => pushTokens.size() > 0 || !!(dingtalkBot && dingtalkBot.isBound()),
  onPending: (item) => {
    if (!voice) return;
    // 静音期间审批仍进 pending，只是不念、不接语音决策。
    if (voiceCommands && voiceCommands.isMuted()) return;
    voice.handle(item).then((result) => {
      const decision = decisionForOutcome(result && result.outcome);
      // 超时 / 取消 / 麦克风不可用：不落决策，留给手机或 broker 超时。
      if (!decision) return;
      broker.decide(item.id, decision);
    }).catch((error) => {
      log.warn("语音确认失败: " + (error && error.message ? error.message : String(error)));
    });
  },
});

// 钉钉单应用机器人（可选）：Stream 入站 + 固定文本审批 + 主动推送。
async function ensureDingTalkBot() {
  const mode = loadMobileMode({ log });
  if (mode === "apk" || mode === "none") return null;
  const cfg = loadDingTalkBotConfig({ log });
  if (!cfg) return null;
  if (dingtalkBot) {
    notifier.unregister(dingtalkBot);
    dingtalkBot.stop();
  }
  dingtalkBot = createDingTalkBot({ config: cfg, log, broker, decide: routeDecision });
  notifier.register(dingtalkBot);
  await dingtalkBot.start();
  const pending = dingtalkSetup && typeof dingtalkSetup.status === "function"
    ? dingtalkSetup.status().pendingBinding
    : null;
  if (pending && pending.code) {
    dingtalkBot.startBinding({ code: pending.code, expiresAt: pending.expiresAt });
    dingtalkSetup.clearPendingBinding();
  }
  log.info("钉钉通道已启用（Stream）");
  return dingtalkBot;
}

const dingtalkSetup = createDingTalkSetup({
  log,
  onProvisioned: () => ensureDingTalkBot(),
});

void ensureDingTalkBot().catch((error) => {
  log.warn("启动钉钉通道失败: " + (error && error.message ? error.message : error));
});

// P1 语音命令：状态查询 / 暂停继续 / 切换关注会话。
// 只持有内存状态（voiceTargetSessionId、voiceMutedUntil），host 重启即复位。
const voiceOverlayClients = new Set();
const voiceRecentEvents = [];
function broadcastVoiceEvent(event) {
  const payload = Object.assign({ at: Date.now() }, event);
  voiceRecentEvents.push(payload);
  if (voiceRecentEvents.length > 30) voiceRecentEvents.shift();
  for (const send of [...voiceOverlayClients]) {
    try {
      send(payload);
    } catch (error) {
      voiceOverlayClients.delete(send);
    }
  }
}
const voiceEvents = {
  subscribe(send) {
    voiceOverlayClients.add(send);
    // 浮层加载可能比命令晚一点：把本次命令最近的事件补发一遍。
    for (const event of voiceRecentEvents.slice(-12)) {
      try { send(event); } catch (error) { /* 已断开 */ }
    }
    return function () { voiceOverlayClients.delete(send); };
  },
};

async function runVoiceCommand() {
  if (!voice || !voiceCommands) {
    log.warn("语音命令: 未启用，忽略本机请求");
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "unknown", reply: "语音未启用。", error: "voice-disabled" });
    broadcastVoiceEvent({ phase: "done", ok: false, intent: "unknown" });
    return { ok: false, intent: "unknown", error: "voice-disabled", reply: "语音未启用。" };
  }
  log.info("语音命令: 收到本机请求");
  voiceRecentEvents.length = 0;
  broadcastVoiceEvent({ phase: "start", mode: "command" });
  const started = Date.now();
  let result;
  try {
    result = await voice.runExclusive(async function () {
      // 先开麦克风并等音频真的在流，再让执行器播提示语；整条命令（含确认）复用同一会话。
      const opened = await voice.open();
      if (opened && opened.ok === false && opened.error === "mic-denied") {
        const reply = "麦克风权限未授予。请到系统设置，隐私与安全性，麦克风里勾选 mo-agent 语音。";
        log.warn("语音命令: 麦克风权限未授予");
        broadcastVoiceEvent({ phase: "result", ok: false, intent: "unknown", reply: reply, error: "mic-denied" });
        try { await voiceSpeaker(reply); } catch (error) { /* 播报失败不影响返回 */ }
        return { ok: false, intent: "unknown", error: "mic-denied", reply: reply };
      }
      if (opened && opened.ok === false) {
        log.warn("语音命令: 开麦失败 " + (opened.error || "unknown")
          + (opened.startupMs ? " 启动=" + opened.startupMs + "ms" : "")
          + (opened.buffers !== undefined ? " 缓冲=" + opened.buffers : ""));
      } else if (opened && opened.ok) {
        log.info("语音命令: 麦克风会话已就绪 启动=" + (opened.startupMs || 0) + "ms 缓冲=" + (opened.buffers || 0)
          + " 峰值=" + (typeof opened.peak === "number" ? opened.peak.toFixed(4) : "-")
          + (opened.routeChanged ? " 路由变化" : ""));
      }
      try {
        return await voiceCommands.runFromMicrophone();
      } finally {
        await voice.close();
      }
    });
  } catch (error) {
    log.warn("语音命令: 请求异常: " + (error && error.message ? error.message : String(error)));
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "unknown", reply: "命令执行失败，请稍后再试。", error: "exception" });
    result = { ok: false, intent: "unknown", reply: "命令执行失败，请稍后再试。", error: "exception" };
  }
  if (result && result.outcome === "busy") {
    log.info("语音命令: 正在处理其他语音，忽略本次请求");
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "unknown", reply: "正在处理上一条语音，请稍后再试。", error: "voice-busy" });
    result = { ok: false, intent: "unknown", error: "voice-busy", reply: "正在处理上一条语音，请稍后再试。" };
  } else if (result && result.outcome === "stopped") {
    log.info("语音命令: 语音通道已停止，忽略本次请求");
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "unknown", reply: "语音已停止。", error: "voice-stopped" });
    result = { ok: false, intent: "unknown", error: "voice-stopped", reply: "语音已停止。" };
  }
  const ok = !!(result && result.ok);
  const intent = (result && result.intent) || "unknown";
  broadcastVoiceEvent({ phase: "done", ok, intent });
  log.info("语音命令: 请求结束 耗时=" + (Date.now() - started) + "ms ok=" + ok + " intent=" + intent);
  return result;
}

// 数据源
const dshEnabled = profiles.some((p) => p.id === "dsh" && p.enabled !== false);
const dsh = dshEnabled ? new DshClient({ home: config.dshHome, baseUrl: config.dshBaseUrl || null, log }) : null;
// Pi 用户自开的会话靠进程内扩展主动连 host；这里只保存控制通道状态。
const piEnabled = profiles.some((p) => p.id === "pi" && p.enabled !== false);
const piControl = piEnabled ? createPiControl({ hub, log }) : null;
const created = await createAdapters({
  hub,
  log,
  config,
  profiles,
  profilesDir: path.join(root, "adapters", "profiles"),
  dsh,
  piControl,
});
const monitor = created.adapters.find((a) => a.name === "dsh") || null;
const piAdapter = created.adapters.find((a) => a.name === "pi") || null;
if (piControl && piAdapter) piControl.onChange = (id) => piAdapter.refreshControl(id);
decisionRouter = createDecisionRouter({ broker, monitor, dsh, log });
for (const adapter of created.adapters) hub.register(adapter);

// P2 语音口述任务：沿用 P1 的「当前关注会话」，先成草稿，严格确认后只发送一次。
function buildDictateRunner() {
  return voice
    ? createDictationRunner({
      hub,
      getTargetSessionId: () => (voiceCommands ? voiceCommands.targetSessionId() : null),
      sendPrompt: (sessionId, text) => dsh.prompt(sessionId, text),
      listen: voice.listen,
      speak: voiceSpeaker,
      prepare: voice.prepare,
      onEvent: broadcastVoiceEvent,
      log,
      maxChars: Number(process.env.MO_AGENT_VOICE_DICTATE_MAX_CHARS || 4000),
      listenDelayMs: Number(process.env.MO_AGENT_VOICE_LISTEN_DELAY_MS || 500),
      timeoutMs: 45000,
      confirmTimeoutMs: 15000,
      silence: 1.6,
      maxSeconds: 30,
    })
    : null;
}

function buildVoiceCommands() {
  return voice
    ? createCommandExecutor({
      hub,
      broker,
      speak: voiceSpeaker,
      listen: voice.listen,
      prepare: voice.prepare,
      onEvent: broadcastVoiceEvent,
      log,
      muteMinutes: Number(process.env.MO_AGENT_VOICE_MUTE_MINUTES || 15),
      timeoutMs: Number(process.env.MO_AGENT_VOICE_TIMEOUT_MS || 15000),
      listenDelayMs: Number(process.env.MO_AGENT_VOICE_LISTEN_DELAY_MS || 500),
    })
    : null;
}

/** 创建一套语音运行时；enabled=false 时只返回空运行时。 */
async function createVoiceRuntime(enabled) {
  const speaker = enabled
    ? createSpeaker({ dryRun: process.env.MO_AGENT_VOICE_DRY === "1", log: voiceEventLog })
    : null;
  const client = enabled && !process.env.MO_AGENT_VOICE_SCRIPT
    ? createHelperClient({ app: voicePaths.bridge, log })
    : null;
  let channel = null;
  let status = "未启用";

  if (enabled) {
    const script = process.env.MO_AGENT_VOICE_SCRIPT;
    if (script) {
      const lines = script.split(/[,，\n]/).map(function (item) { return item.trim(); }).filter(Boolean);
      channel = createVoiceChannel(Object.assign({
        listener: createScriptedListener(lines, { log: voiceEventLog }),
        nonceFactory: () => process.env.MO_AGENT_VOICE_NONCE || makeNonce(4),
        speaker,
        eventLog: voiceEventLog,
        log,
      }, voicePaths));
      status = "已启用（脚本应答）";
      log.info("语音以脚本应答启用（调试）");
    } else {
      const ready = await checkVoiceReady(Object.assign({ log, client }, voicePaths));
      if (ready.ready) {
        channel = createVoiceChannel(Object.assign({
          timeoutMs: Number(process.env.MO_AGENT_VOICE_TIMEOUT_MS || 15000),
          maxAttempts: Number(process.env.MO_AGENT_VOICE_ATTEMPTS || 3),
          speaker,
          client,
          eventLog: voiceEventLog,
          log,
        }, voicePaths));
        status = ready.micStatus === 0 ? "已启用（首次会请求麦克风）" : "已启用";
        log.info("语音已启用");
      } else {
        status = "不可用：" + ready.reason;
        log.warn("语音未启用：" + ready.reason);
      }
    }
  }

  return { speaker, client, channel, status };
}

/** 停掉旧通道和 helper；必须在创建新 helper 之前调用，避免 shutdown 误杀新 helper。 */
async function stopVoiceRuntime() {
  if (voiceNotifierChannel) {
    notifier.unregister(voiceNotifierChannel);
    voiceNotifierChannel = null;
  }
  if (voice && typeof voice.stop === "function") voice.stop();
  if (voiceClient && typeof voiceClient.shutdown === "function") {
    try { await voiceClient.shutdown(); } catch (error) { /* helper 可能已退出 */ }
  }
  voice = null;
  voiceClient = null;
  voiceSpeaker = null;
  voiceCommands = null;
  dictateRunner = null;
}

/** 挂载新语音运行时，并重新注册通知播报。 */
async function applyVoiceRuntime(runtime) {
  voiceSpeaker = runtime.speaker;
  voiceClient = runtime.client;
  voice = runtime.channel;
  voiceStatus = runtime.status;
  voiceCommands = buildVoiceCommands();
  dictateRunner = buildDictateRunner();

  if (voice) {
    // 静音只影响语音播报与语音审批，手机/终端通知不受影响。
    voiceNotifierChannel = createVoiceNotifier({
      speaker: voiceSpeaker,
      log,
      isMuted: function () { return voiceCommands ? voiceCommands.isMuted() : false; },
    });
    notifier.register(voiceNotifierChannel);
    // 保活：helper 空闲 5 分钟会退出，下一次授权又要冷启动；
    // 每分钟 ping 一次，让它保持热状态。
    if (voiceClient && typeof voiceClient.keepalive === "function") voiceClient.keepalive();
    log.info("语音播报已挂到 critical 通知");
  }
}

/** 串行重载，避免两个设置请求同时启停语音。 */
async function reloadVoiceRuntime() {
  const task = voiceReloadPromise.then(async function () {
    const enabled = voiceRuntimeEnabled();
    try {
      await stopVoiceRuntime();
      const runtime = await createVoiceRuntime(enabled);
      await applyVoiceRuntime(runtime);
      log.info("语音运行时: " + voiceStatus);
      return { ok: true, enabled, ready: !!voice, status: voiceStatus };
    } catch (error) {
      voiceStatus = "不可用：" + (error && error.message ? error.message : String(error));
      log.warn("语音运行时重载失败: " + voiceStatus);
      return { ok: false, enabled, ready: false, status: voiceStatus, error: voiceStatus };
    }
  });
  voiceReloadPromise = task.then(function () {}, function () {});
  return task;
}

await reloadVoiceRuntime();

async function runDictate() {
  if (!voice || !dictateRunner) {
    log.warn("语音口述: 未启用，忽略本机请求");
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "dictate", reply: "语音未启用。", error: "voice-disabled" });
    broadcastVoiceEvent({ phase: "done", ok: false, intent: "dictate" });
    return { ok: false, intent: "dictate", error: "voice-disabled", reply: "语音未启用。" };
  }
  if (!dsh) {
    log.warn("语音口述: DSH 不可用，未发送");
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "dictate", reply: "DSH 不可用，未发送。", error: "dsh-unavailable" });
    broadcastVoiceEvent({ phase: "done", ok: false, intent: "dictate" });
    return { ok: false, intent: "dictate", error: "dsh-unavailable", reply: "DSH 不可用，未发送。" };
  }
  log.info("语音口述: 收到本机请求");
  voiceRecentEvents.length = 0;
  const started = Date.now();
  let result;
  try {
    result = await voice.runExclusive(async function () {
      // 与语音命令一样复用同一个音频会话：先等麦克风出音频，再提示用户开口。
      const opened = await voice.open();
      if (opened && opened.ok === false && opened.error === "mic-denied") {
        const reply = "麦克风权限未授予。请到系统设置，隐私与安全性，麦克风里勾选 mo-agent 语音。";
        log.warn("语音口述: 麦克风权限未授予");
        broadcastVoiceEvent({ phase: "result", ok: false, intent: "dictate", reply: reply, error: "mic-denied" });
        try { await voiceSpeaker(reply); } catch (error) { /* 播报失败不影响返回 */ }
        return { ok: false, intent: "dictate", error: "mic-denied", reply: reply };
      }
      if (opened && opened.ok === false) {
        log.warn("语音口述: 开麦失败 " + (opened.error || "unknown")
          + (opened.startupMs ? " 启动=" + opened.startupMs + "ms" : "")
          + (opened.buffers !== undefined ? " 缓冲=" + opened.buffers : ""));
      } else if (opened && opened.ok) {
        log.info("语音口述: 麦克风会话已就绪 启动=" + (opened.startupMs || 0) + "ms 缓冲=" + (opened.buffers || 0)
          + " 峰值=" + (typeof opened.peak === "number" ? opened.peak.toFixed(4) : "-"));
      }
      try {
        return await dictateRunner.runFromMicrophone();
      } finally {
        await voice.close();
      }
    });
  } catch (error) {
    log.warn("语音口述: 请求异常: " + (error && error.message ? error.message : String(error)));
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "dictate", reply: "口述执行失败，请稍后再试。", error: "exception" });
    result = { ok: false, intent: "dictate", reply: "口述执行失败，请稍后再试。", error: "exception" };
  }
  if (result && result.outcome === "busy") {
    log.info("语音口述: 正在处理其他语音，忽略本次请求");
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "dictate", reply: "正在处理上一条语音，请稍后再试。", error: "voice-busy" });
    result = { ok: false, intent: "dictate", error: "voice-busy", reply: "正在处理上一条语音，请稍后再试。" };
  } else if (result && result.outcome === "stopped") {
    log.info("语音口述: 语音通道已停止，忽略本次请求");
    broadcastVoiceEvent({ phase: "result", ok: false, intent: "dictate", reply: "语音已停止。", error: "voice-stopped" });
    result = { ok: false, intent: "dictate", error: "voice-stopped", reply: "语音已停止。" };
  }
  const ok = !!(result && result.ok);
  broadcastVoiceEvent({ phase: "done", ok: ok, intent: "dictate" });
  log.info("语音口述: 请求结束 耗时=" + (Date.now() - started) + "ms ok=" + ok
    + (result && result.error ? " 原因=" + result.error : ""));
  return result;
}

const moHost = createMoAgentServer({
  config,
  hub,
  broker,
  decide: routeDecision,
  dsh,
  piControl,
  processes,
  runtime,
  log,
  webDir,
  localToken,
  monitor,
  getDingTalk: () => dingtalkBot,
  dingtalkSetup,
  onDingTalkReset: () => {
    if (!dingtalkBot) return;
    notifier.unregister(dingtalkBot);
    dingtalkBot.stop();
    dingtalkBot = null;
  },
  pairing,
  voiceReload: reloadVoiceRuntime,
  voiceTest: testVoice,
  voiceCommand: runVoiceCommand,
  dictate: runDictate,
  voiceEvents,
  pairHandler: handlePairRoutes,
  settingsHandler: handleSettingsRoutes,
  hooksManager,
  apkPath,
  logFile,
  deviceFile,
  pushTokens,
});
runtime.clientCount = moHost.clientCount;

// 谁把 host 拉起来的：优先用显式环境变量（CLI / 桌面壳会设置），
// 否则尽力问一下父进程名字，纯粹用于展示。
function parentName(pid) {
  try {
    if (process.platform === "linux") return fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim();
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 500 });
    return out.trim().split("/").pop() || null;
  } catch {
    return null;
  }
}

function resolveLauncher() {
  const by = process.env.MO_AGENT_LAUNCHED_BY;
  if (by) return { by, pid: Number(process.env.MO_AGENT_LAUNCHED_PID) || null };
  const name = parentName(process.ppid);
  return { by: name ? "unknown(" + name + ")" : "unknown", pid: process.ppid };
}

const LAUNCHER = resolveLauncher();

function writeSessionFile(port) {
  const dir = path.dirname(sessionFile);
  const file = sessionFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 管理页鉴权也读这个令牌，文件权限收紧到仅当前用户。
    fs.writeFileSync(
      file,
      JSON.stringify({
        url: "http://127.0.0.1:" + port,
        token: localToken,
        pid: process.pid,
        launcher: LAUNCHER.by,
        launcherPid: LAUNCHER.pid,
      }, null, 2),
      { mode: 0o600 },
    );
    try { fs.chmodSync(file, 0o600); } catch (error) { /* 非 POSIX 或无权限时忽略 */ }
    return file;
  } catch (error) {
    return null;
  }
}

function banner(port) {
  const lines = [];
  lines.push("");
  lines.push("  mo-agent");
  lines.push("  ------------------------------------------------");
  lines.push("  本机:     http://127.0.0.1:" + port + "/");
  for (const item of localIPv4List()) lines.push("  手机:     http://" + item.address + ":" + port + "/   (" + item.name + ")");
  lines.push("  配对码:   " + moHost.pin);
  lines.push("  启动者:   " + LAUNCHER.by + (LAUNCHER.pid ? " (pid " + LAUNCHER.pid + ")" : ""));
  lines.push("  数据源:   " + created.adapters.map((a) => a.name).join(", "));
  lines.push("  Agent档案: " + profiles.map((p) => p.id + (p.enabled === false ? "(未启用)" : "")).join(", "));
  lines.push("  Agent接入: http://127.0.0.1:" + port + "/agents （hooks 一键配置）");
  lines.push("  远程批准: " + (config.approvalTimeoutMs / 1000) + "s 超时；无手机在线时交回本地终端");
  lines.push("  语音:     " + voiceStatus);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  moHost.server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      log.error("端口 " + config.port + " 已被占用。可能已有一个 mo-agent 在运行；换一个端口用 --port，或先停掉旧的进程。");
    } else {
      log.error("监听失败: " + (error && error.message ? error.message : String(error)));
    }
    process.exit(1);
  });

  moHost.server.listen(config.port, config.host, () => {
    const port = moHost.server.address().port;
    log.info(banner(port));
    const addresses = localIPv4List();
    const primary = addresses.length ? addresses[0].address : "127.0.0.1";
    const issued = pairing.peek();
    const payload = buildPairPayload("http://" + primary + ":" + port, issued.token);
    QRCode.toString(payload, { type: "terminal", small: true }).then((art) => {
      log.info("扫码配对（二维码见下，或在本机浏览器打开 http://127.0.0.1:" + port + "/pair ）\n" + art);
    }).catch(() => {});
    const file = writeSessionFile(port);
    if (file) log.info("本机会话凭证已写入 " + file + "（供 hook 回调使用）");
    else log.warn("无法写入本机会话凭证，hook 需用 MO_AGENT_URL / MO_AGENT_TOKEN 环境变量");
  });

  for (const adapter of created.adapters) {
    try {
      adapter.start();
    } catch (error) {
      log.error("启动数据源 " + adapter.name + " 失败: " + error.message);
    }
  }

  if (dsh) {
    const connect = () => {
      dsh.connect().catch((error) => {
        log.warn("连接 DSH 失败: " + error.message + "（5 秒后重试）");
        setTimeout(connect, 5000);
      });
    };
    connect();
  }

  const shutdown = () => {
    log.info("正在关闭…");
    if (procTimer) clearInterval(procTimer);
    for (const adapter of created.adapters) {
      try {
        adapter.stop();
      } catch (error) {
        /* 忽略 */
      }
    }
    if (voice) voice.stop();
    if (dingtalkBot) dingtalkBot.stop();
    broker.cancelAll("shutdown");
    if (dsh) dsh.close();
    moHost.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 被桌面 App 拉起时，如果 App 没了（进程被交给 launchd，ppid 变成 1），
  // 自己退出——否则会留下「占着端口却没人能用」的孤儿进程，
  // 表现为：托盘不见了，但服务还在，重新安装也删不掉旧 bundle。
  // 手动在终端跑时可设 MO_AGENT_NO_PARENT_WATCH=1 关掉。
  if (process.env.MO_AGENT_NO_PARENT_WATCH !== "1") {
    const initialPpid = process.ppid;
    const watcher = setInterval(() => {
      if (initialPpid !== 1 && process.ppid === 1) {
        log.warn("父进程已退出，mo-agent 服务随之关闭");
        shutdown();
      }
    }, 5000);
    if (typeof watcher.unref === "function") watcher.unref();
  }
}

main().catch((error) => {
  log.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

