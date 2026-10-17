import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { createRotatingSink } from "./log-file.mjs";
import { Hub } from "../core/hub.mjs";
import { Notifier } from "../core/notify.mjs";
import { loadNotifyChannels } from "./notify-webhook.mjs";
import { createPushTokenStore } from "./push-tokens.mjs";
import { ensureNotifyConfig } from "./notify-config.mjs";
import { DshClient } from "../adapters/dsh.mjs";
import { createAdapters, loadProfiles } from "../adapters/registry.mjs";
import { ApprovalBroker } from "../approvals/broker.mjs";
import { checkVoiceReady, createVoiceChannel, decisionForOutcome } from "./voice/channel.mjs";
import { createScriptedListener } from "./voice/io.mjs";
import { makeNonce } from "./voice/text.mjs";
import { createSpeaker } from "./voice/tts.mjs";
import { createVoiceNotifier } from "./voice/notifier.mjs";
import { createCommandExecutor } from "./voice/commands.mjs";
import { createHelperClient } from "./voice/helper-client.mjs";
import { createMoAgentServer, localIPv4List } from "./http.mjs";
import { handlePairRoutes } from "./pair-http.mjs";
import { PairingManager, buildPairPayload } from "./pairing.mjs";
import QRCode from "qrcode";
import { scanProcesses } from "../adapters/process-scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// 打包成单文件运行时时，壳会通过 MO_AGENT_ROOT 指定运行时目录；
// 开发态则回退到源码目录。
const root = process.env.MO_AGENT_ROOT ? path.resolve(process.env.MO_AGENT_ROOT) : path.resolve(here, "..");
const webDir = path.join(root, "app", "web");
const apkPath = path.join(root, "app", "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
// host 自己写这份日志并在 5MB 处轮转（.1 -> .3），桌面壳不再重定向 stdout/stderr。
// 桌面端的启动/退出信息单独写 desktop.log，避免两个进程抢同一个文件。
const logFile = process.env.MO_AGENT_LOG_FILE || path.join(os.homedir(), "Library", "Logs", "mo-agent", "host.log");
// 已配对设备令牌落盘，host 重启后不丢（否则每次「重启服务」都要重新配对）
const deviceFile = process.env.MO_AGENT_DEVICE_FILE || path.join(os.homedir(), ".mo-agent", "devices.json");

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
for (const channel of loadNotifyChannels({ log, getPushTokens: () => pushTokens.list() })) {
  notifier.register(channel);
  log.info("已注册通知通道: " + channel.name);
}
notifier.start();
const localToken = process.env.MO_AGENT_LOCAL_TOKEN || randomBytes(24).toString("base64url");
// profiles 是运行时从磁盘读的，打包成单文件后必须显式指向运行时目录
const profiles = loadProfiles(path.join(root, "adapters", "profiles"));

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

const voiceEnabled = process.env.MO_AGENT_VOICE === "1"
  || (process.env.MO_AGENT_VOICE !== "0" && readVoiceConfig());
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
const voiceSpeaker = voiceEnabled
  ? createSpeaker({ dryRun: process.env.MO_AGENT_VOICE_DRY === "1", log: voiceEventLog })
  : null;
// 常驻 helper：open 启动一次，之后所有命令走本地 socket。
const voiceClient = voiceEnabled && !process.env.MO_AGENT_VOICE_SCRIPT
  ? createHelperClient({ app: voicePaths.bridge, log })
  : null;
let voice = null;
let voiceStatus = "未启用";
if (voiceEnabled) {
  const script = process.env.MO_AGENT_VOICE_SCRIPT;
  if (script) {
    const lines = script.split(/[,，\n]/).map(function (item) { return item.trim(); }).filter(Boolean);
    voice = createVoiceChannel(Object.assign({
      listener: createScriptedListener(lines, { log: voiceEventLog }),
      nonceFactory: () => process.env.MO_AGENT_VOICE_NONCE || makeNonce(4),
      speaker: voiceSpeaker,
      eventLog: voiceEventLog,
      log,
    }, voicePaths));
    voiceStatus = "已启用（脚本应答）";
    log.info("语音以脚本应答启用（调试）");
  } else {
    const ready = await checkVoiceReady(Object.assign({ log, client: voiceClient }, voicePaths));
    if (ready.ready) {
      voice = createVoiceChannel(Object.assign({
        timeoutMs: Number(process.env.MO_AGENT_VOICE_TIMEOUT_MS || 15000),
        maxAttempts: Number(process.env.MO_AGENT_VOICE_ATTEMPTS || 3),
        speaker: voiceSpeaker,
        client: voiceClient,
        eventLog: voiceEventLog,
        log,
      }, voicePaths));
      voiceStatus = ready.micStatus === 0 ? "已启用（首次会请求麦克风）" : "已启用";
      log.info("语音已启用");
    } else {
      voiceStatus = "不可用：" + ready.reason;
      log.warn("语音未启用：" + ready.reason);
    }
  }
}

let voiceCommands = null;

if (voice) {
  // 静音只影响语音播报与语音审批，手机/终端通知不受影响。
  notifier.register(createVoiceNotifier({
    speaker: voiceSpeaker,
    log,
    isMuted: function () { return voiceCommands ? voiceCommands.isMuted() : false; },
  }));
  // 保活：helper 空闲 5 分钟会退出，下一次授权又要冷启动；
  // 每分钟 ping 一次，让它保持热状态。
  if (voiceClient && typeof voiceClient.keepalive === "function") voiceClient.keepalive();
  log.info("语音播报已挂到 critical 通知");
}

async function testVoice() {
  if (!voice) return { ok: false, error: "voice-disabled" };
  const result = await voice.test();
  return Object.assign({ ok: true }, result);
}

// 远程批准中枢（语音只是另一个决策端）
const runtime = {};
const pairing = new PairingManager({ log, ttlMs: config.qrTtlMs || 5 * 60 * 1000 });

const broker = new ApprovalBroker({
  hub,
  log,
  timeoutMs: config.approvalTimeoutMs,
  // 静音时语音不再算作「在线决策端」：没有手机就直接交回终端，不白等。
  isClientConnected: () => (runtime.clientCount ? runtime.clientCount() > 0 : false)
    || (!!voice && !(voiceCommands && voiceCommands.isMuted())),
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

// P1 语音命令：状态查询 / 暂停继续 / 切换关注会话。
// 只持有内存状态（voiceTargetSessionId、voiceMutedUntil），host 重启即复位。
if (voice) {
  voiceCommands = createCommandExecutor({
    hub,
    broker,
    speak: voiceSpeaker,
    listen: voice.listen,
    log,
    muteMinutes: Number(process.env.MO_AGENT_VOICE_MUTE_MINUTES || 15),
    timeoutMs: Number(process.env.MO_AGENT_VOICE_TIMEOUT_MS || 15000),
  });
}

async function runVoiceCommand() {
  if (!voice || !voiceCommands) {
    return { ok: false, intent: "unknown", error: "voice-disabled", reply: "语音未启用。" };
  }
  const result = await voice.runExclusive(function () {
    return voiceCommands.runFromMicrophone();
  });
  if (result && result.outcome === "busy") {
    return { ok: false, intent: "unknown", error: "voice-busy", reply: "正在处理上一条语音，请稍后再试。" };
  }
  if (result && result.outcome === "stopped") {
    return { ok: false, intent: "unknown", error: "voice-stopped", reply: "语音已停止。" };
  }
  return result;
}

// 数据源
const dshEnabled = profiles.some((p) => p.id === "dsh" && p.enabled !== false);
const dsh = dshEnabled ? new DshClient({ home: config.dshHome, baseUrl: config.dshBaseUrl || null, log }) : null;
const created = createAdapters({ hub, log, config, profiles, dsh });
const monitor = created.adapters.find((a) => a.name === "dsh") || null;
for (const adapter of created.adapters) hub.register(adapter);

const moHost = createMoAgentServer({
  config,
  hub,
  broker,
  dsh,
  processes,
  runtime,
  log,
  webDir,
  localToken,
  monitor,
  pairing,
  voiceTest: testVoice,
  voiceCommand: runVoiceCommand,
  pairHandler: handlePairRoutes,
  apkPath,
  logFile,
  deviceFile,
  pushTokens,
});
runtime.clientCount = moHost.clientCount;

function writeSessionFile(port) {
  const dir = path.join(os.homedir(), ".mo-agent");
  const file = path.join(dir, "session.json");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:" + port, token: localToken }, null, 2));
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
  lines.push("  数据源:   " + created.adapters.map((a) => a.name).join(", "));
  lines.push("  Agent档案: " + profiles.map((p) => p.id + (p.enabled === false ? "(未启用)" : "")).join(", "));
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

