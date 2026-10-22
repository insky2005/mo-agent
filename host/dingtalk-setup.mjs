import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { beginRegistration, waitForCredentials } from "./dingtalk-device.mjs";

/**
 * 钉钉扫码创建的会话控制器。
 *
 * 只负责 device-code 的 init/begin/poll 与 notify.json 回填；
 * 创建完成后通过 onProvisioned 通知 host 启动/重载 bot。
 */

const DEFAULT_SOURCE = "MO_AGENT";

function notifyFileDefault() {
  return process.env.MO_AGENT_NOTIFY_FILE || path.join(os.homedir(), ".mo-agent", "notify.json");
}

function readChannels(file) {
  try {
    if (!fs.existsSync(file)) return { kind: "object", value: { channels: [] } };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) return { kind: "array", value: parsed };
    if (parsed && Array.isArray(parsed.channels)) return { kind: "object", value: parsed };
    return { kind: "object", value: { channels: [] } };
  } catch (error) {
    return { kind: "object", value: { channels: [] } };
  }
}

function writeCredentials(file, credentials, source) {
  const current = readChannels(file);
  const channel = {
    type: "dingtalk-bot",
    enabled: true,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    ...(credentials.robotCode ? { robotCode: credentials.robotCode } : {}),
    source,
    target: { mode: "dm" },
    events: {
      approval: true,
      question: true,
      error: true,
      completed: false,
      canceled: false,
      attention: false,
    },
  };
  let next;
  if (current.kind === "array") {
    const channels = current.value.filter((item) => !item || item.type !== "dingtalk-bot");
    channels.push(channel);
    next = { mobile: { mode: "dingtalk" }, channels };
  } else {
    const channels = (current.value.channels || []).filter((item) => !item || item.type !== "dingtalk-bot");
    channels.push(channel);
    const currentMode = current.value.mobile && current.value.mobile.mode;
    const mode = currentMode === "both" ? "both" : "dingtalk";
    next = Object.assign({}, current.value, { mobile: { mode }, channels });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (error) { /* ignore */ }
}

export function createDingTalkSetup(options) {
  const opts = options || {};
  const log = opts.log || { info: () => {}, warn: () => {} };
  const fetchImpl = opts.fetchImpl || fetch;
  const notifyFile = opts.notifyFile || notifyFileDefault();
  const source = opts.source || process.env.MO_AGENT_DINGTALK_REGISTRATION_SOURCE || DEFAULT_SOURCE;
  const onProvisioned = typeof opts.onProvisioned === "function" ? opts.onProvisioned : null;
  const now = opts.now || Date.now;
  const sleep = opts.sleep;

  let state = "idle";
  let registration = null;
  let error = null;
  let startedAt = 0;
  let generation = 0;
  let progress = "";
  let progressDetail = null;
  let lastStatusAt = 0;
  let pendingBinding = null;

  function status() {
    lastStatusAt = now();
    return {
      ok: true,
      state,
      error,
      startedAt: startedAt || null,
      progress: progress || null,
      progressDetail: progressDetail || null,
      pendingBinding,
      expiresAt: registration
        ? startedAt + (Number(registration.expiresInSeconds) || 0) * 1000
        : null,
      verificationUriComplete: state === "polling" && registration ? registration.verificationUriComplete : null,
      notifyFileConfigured: fs.existsSync(notifyFile),
    };
  }

  async function start() {
    if (state === "polling" && registration) {
      const expiresAt = startedAt + (Number(registration.expiresInSeconds) || 0) * 1000;
      if (expiresAt && now() > expiresAt) {
        generation += 1;
        state = "idle";
        registration = null;
      }
    }
    if (state === "qr_waiting" || state === "polling") return status();
    generation += 1;
    const current = generation;
    state = "qr_waiting";
    error = null;
    progress = "";
    progressDetail = null;
    startedAt = now();
    lastStatusAt = now();
    registration = null;

    try {
      registration = await beginRegistration({ fetchImpl, source });
      state = "polling";
    } catch (err) {
      state = "error";
      error = err && err.message ? err.message : String(err);
      log.warn("钉钉扫码创建失败: " + error);
      return status();
    }

    void (async () => {
      try {
        const credentials = await waitForCredentials(registration, {
          fetchImpl,
          now,
          sleep,
          onStatus: (status, detail) => {
            progress = status;
            progressDetail = detail || null;
            log.info("钉钉扫码状态: " + status + (detail && detail.failReason ? " (" + detail.failReason + ")" : ""));
          },
          shouldStop: () => generation !== current || (lastStatusAt > 0 && now() - lastStatusAt > 15000),
        });
        if (generation !== current) return;
        writeCredentials(notifyFile, credentials, source);
        state = "done";
        log.info("钉钉应用已创建并写入通知配置: " + notifyFile);
        if (onProvisioned) await onProvisioned(credentials);
      } catch (err) {
        if (generation !== current) return;
        if (/canceled/i.test(err && err.message ? err.message : "")) {
          state = "idle";
          registration = null;
          progress = "";
          progressDetail = null;
          lastStatusAt = 0;
          return;
        }
        state = "error";
        error = err && err.message ? err.message : String(err);
        log.warn("钉钉扫码创建未完成: " + error);
      }
    })();

    return status();
  }

  function cancel() {
    generation += 1;
    state = "idle";
    registration = null;
    error = null;
    progress = "";
    progressDetail = null;
    lastStatusAt = 0;
    return status();
  }

  /** 应用还没创建时，也可以先把配对码展示出来；bot 创建后自动接管。 */
  function startPendingBinding() {
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    pendingBinding = { code, expiresAt: now() + 300000 };
    return { ok: true, code, expiresAt: pendingBinding.expiresAt };
  }

  function clearPendingBinding() {
    pendingBinding = null;
  }

  /** 用户已在开发者后台手动创建应用/机器人，直接保存凭据。 */
  async function saveManual(input) {
    const data = input || {};
    const credentials = {
      clientId: String(data.clientId || "").trim(),
      clientSecret: String(data.clientSecret || "").trim(),
      robotCode: String(data.robotCode || "").trim(),
      status: "MANUAL",
    };
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error("Client ID 和 Client Secret 必填");
    }
    generation += 1;
    writeCredentials(notifyFile, credentials, source);
    state = "done";
    error = null;
    progress = "MANUAL";
    progressDetail = null;
    registration = null;
    lastStatusAt = 0;
    log.info("已手动写入钉钉应用凭据: " + notifyFile);
    if (onProvisioned) await onProvisioned(credentials);
    return status();
  }

  /** 解绑并清除本机的钉钉应用配置，回到“未创建”。 */
  function removeCredentials() {
    const current = readChannels(notifyFile);
    let next;
    if (current.kind === "array") {
      next = current.value.filter((item) => !item || item.type !== "dingtalk-bot");
    } else {
      const channels = (current.value.channels || []).filter((item) => !item || item.type !== "dingtalk-bot");
      next = Object.assign({}, current.value, { channels });
    }
    fs.mkdirSync(path.dirname(notifyFile), { recursive: true });
    const tmp = notifyFile + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, notifyFile);
    try { fs.chmodSync(notifyFile, 0o600); } catch (error) { /* ignore */ }
    generation += 1;
    state = "idle";
    registration = null;
    error = null;
    progress = "";
    progressDetail = null;
    lastStatusAt = 0;
    pendingBinding = null;
    return status();
  }

  return { start, status, cancel, saveManual, removeCredentials, startPendingBinding, clearPendingBinding };
}
