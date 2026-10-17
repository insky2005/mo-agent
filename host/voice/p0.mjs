#!/usr/bin/env node
/**
 * P0 语音确认 Demo：先念草稿，再听回话，明确同意才放行。
 *
 *   node host/voice/p0.mjs --kind approval --transcript 四七二九
 *   node host/voice/p0.mjs --kind dictation --text "把登录页改成深色" --transcript 确认发送
 *   node host/voice/p0.mjs --broker --transcript 四七二九
 *   node host/voice/p0.mjs --mode replay --audio a.wav --audio b.wav --broker
 *   node host/voice/p0.mjs --live --kind approval
 *
 * 日志走 stderr，最终结果是一段 JSON 走 stdout。
 */
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApprovalDraft, buildDictationDraft, makeNonce } from "./text.mjs";
import { OUTCOME, runVoiceConfirm } from "./confirm.mjs";
import { createSpeaker } from "./tts.mjs";
import { createWhisperTranscriber } from "./whisper.mjs";
import { createMicCapture, createScriptedListener, createVoiceListener } from "./io.mjs";
import { createHelperClient } from "./helper-client.mjs";
import { Hub } from "../../core/hub.mjs";
import { ApprovalBroker, DECISION } from "../../approvals/broker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes("--" + name);
}

function value(name, fallback) {
  const index = argv.indexOf("--" + name);
  if (index === -1) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : true;
}

function values(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--" + name) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) out.push(next);
  }
  return out;
}

function log(event) {
  process.stderr.write("[voice] " + JSON.stringify(event) + "\n");
}

const mode = String(value("mode", flag("live") ? "live" : "simulate"));
const brokerMode = flag("broker");
const kind = brokerMode ? "approval" : String(value("kind", "approval"));
const timeoutMs = Number(value("timeout", "15000"));
const maxAttempts = Number(value("attempts", "3"));
const dryTts = flag("dry-tts") || (mode !== "live" && !flag("speak"));

const bridge = String(value("bridge", path.join(root, ".build", "mo-agent 语音.app", "Contents", "MacOS", "mo-voice-bridge")));
const whisperBin = String(value("whisper", path.join(root, ".build", "bin", "whisper-cli")));
const smallModel = path.join(root, ".build", "models", "ggml-small-q8_0.bin");
const baseModel = path.join(root, ".build", "models", "ggml-base.bin");
function usableModel(file) {
  try {
    return existsSync(file) && statSync(file).size > 50 * 1024 * 1024;
  } catch (error) {
    return false;
  }
}
const model = String(value("model", usableModel(smallModel) ? smallModel : baseModel));


const speaker = createSpeaker({ dryRun: dryTts, log });

async function readStdinLines() {
  if (!flag("stdin")) return [];
  try {
    const text = await fs.readFile(0, "utf8");
    return text.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    return [];
  }
}

async function makeListener() {
  if (mode === "live") {
    for (const [label, file] of [["语音桥", bridge], ["whisper", whisperBin], ["模型", model]]) {
      try {
        await fs.access(file);
      } catch (error) {
        throw new Error("缺少 " + label + ": " + file + "（先运行 npm run voice:build）");
      }
    }
    const transcribe = createWhisperTranscriber({ binary: whisperBin, model, log });
    const client = createHelperClient({ app: bridge, log });
    const capture = createMicCapture({ client });
    return createVoiceListener({ capture, transcribe, log });
  }

  if (mode === "replay") {
    const files = values("audio");
    if (!files.length) throw new Error("replay 模式需要 --audio（可重复）");
    const transcribe = createWhisperTranscriber({ binary: whisperBin, model, log });
    let index = 0;
    return async function listen() {
      if (index >= files.length) return { ok: false, error: "timeout" };
      const file = path.resolve(files[index]);
      index += 1;
      return transcribe(file);
    };
  }

  let script = values("transcript");
  if (!script.length) script = await readStdinLines();
  if (!script.length) {
    throw new Error("simulate 模式需要 --transcript（可重复）或 --stdin");
  }
  script = script.map(function (item) {
    if (typeof item === "string" && item.trim().startsWith("{")) {
      try { return JSON.parse(item); } catch (error) { return item; }
    }
    return item;
  });
  return createScriptedListener(script, { log });
}

function decisionOf(outcome) {
  if (outcome === OUTCOME.ALLOW) return DECISION.ALLOW_ONCE;
  if (outcome === OUTCOME.REJECT) return DECISION.REJECT_ONCE;
  return DECISION.DEFER;
}

function targetOf(payload) {
  const input = (payload && payload.toolInput) || {};
  return String(input.command || input.file_path || input.path || input.url || input.query || payload.title || "");
}

async function audit(entry) {
  try {
    await fs.mkdir(path.join(root, ".build"), { recursive: true });
    await fs.appendFile(path.join(root, ".build", "voice-audit.jsonl"), JSON.stringify(entry) + "\n");
  } catch (error) {
    log({ type: "audit-failed", message: String(error && error.message ? error.message : error) });
  }
}

async function runBroker(listener) {
  const logger = { info: function () {}, warn: log, error: log };
  const hub = new Hub({ log: logger });
  let resolvePending;
  const pendingPromise = new Promise(function (resolve) { resolvePending = resolve; });
  const broker = new ApprovalBroker({
    hub,
    log: logger,
    timeoutMs: Number(value("approval-timeout", "120000")),
    isClientConnected: () => true,
    onPending: function (item) { resolvePending(item); },
  });

  const payload = {
    agent: String(value("agent", "claude-code")),
    agentLabel: String(value("agent-label", "Claude Code")),
    toolName: String(value("tool", "Bash")),
    title: String(value("title", "执行命令")),
    toolInput: { command: String(value("target", "rm -rf build")) },
  };

  const requestPromise = broker.request(payload);
  const item = await pendingPromise;
  const nonce = String(value("nonce", makeNonce(4)));
  const draft = buildApprovalDraft({
    agentLabel: item.payload.agentLabel || item.payload.agent,
    toolName: item.payload.toolName,
    title: item.payload.title,
    target: targetOf(item.payload),
    nonce,
  });
  log({ type: "draft", kind: draft.kind, prompt: draft.prompt, danger: draft.danger });

  const result = await runVoiceConfirm({
    draft,
    io: { speak: speaker, listen: listener },
    nonce,
    timeoutMs,
    maxAttempts,
    log,
  });

  const decision = decisionOf(result.outcome);
  const decided = broker.decide(item.id, decision);
  const final = await requestPromise;
  return {
    mode: "broker",
    kind: "approval",
    outcome: result.outcome,
    decision: final.decision,
    decided: decided,
    attempts: result.attempts,
    heard: result.heard,
    nonce,
    pendingId: item.id,
  };
}

async function runStandalone(listener) {
  const nonce = String(value("nonce", makeNonce(4)));
  let draft;
  if (kind === "dictation") {
    draft = buildDictationDraft({ text: String(value("text", "")) });
  } else if (kind === "approval") {
    draft = buildApprovalDraft({
      agentLabel: String(value("agent-label", "Claude Code")),
      toolName: String(value("tool", "Bash")),
      target: String(value("target", "rm -rf build")),
      nonce,
    });
  } else {
    throw new Error("未知的 --kind: " + kind);
  }
  log({ type: "draft", kind: draft.kind, prompt: draft.prompt, danger: draft.danger });

  const result = await runVoiceConfirm({
    draft,
    io: { speak: speaker, listen: listener },
    nonce: draft.kind === "approval" ? nonce : undefined,
    timeoutMs,
    maxAttempts,
    log,
  });

  return {
    mode: "standalone",
    kind: draft.kind,
    outcome: result.outcome,
    decision: draft.kind === "approval" ? decisionOf(result.outcome) : (result.outcome === OUTCOME.ALLOW ? "send" : "drop"),
    attempts: result.attempts,
    heard: result.heard,
    nonce: draft.kind === "approval" ? nonce : undefined,
    text: draft.kind === "dictation" ? draft.text : undefined,
  };
}

async function main() {
  const listener = await makeListener();
  const started = Date.now();
  let result;
  try {
    result = brokerMode ? await runBroker(listener) : await runStandalone(listener);
  } finally {
    // 无论结果如何都留一条审计：说了什么、最终怎么判的。
  }
  const entry = Object.assign({ at: new Date().toISOString(), ms: Date.now() - started, input: mode }, result);
  await audit(entry);
  process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
}

main().catch(function (error) {
  process.stderr.write("[voice] 失败: " + (error && error.stack ? error.stack : String(error)) + "\n");
  process.exit(1);
});
