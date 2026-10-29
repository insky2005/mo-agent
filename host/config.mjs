import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGlobalConfig } from "../cli/lib/config.mjs";

const DEFAULTS = {
  host: "0.0.0.0",
  port: 7788,
  pollMs: 1500,
  dshHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"),
  dshBaseUrl: process.env.DSH_WEB_URL || "",
  authRequired: true,
  pin: "",
  historySize: 800,
  activeWindowMs: 6 * 3600 * 1000,
  transcriptWindowMs: 72 * 3600 * 1000,
  maxSessions: 40,
  logLevel: "info",
  speak: false,
  // 有推送设备但 App 尚未连上时，等它连上来的窗口；超时才交回本地终端。
  approvalNoClientGraceMs: 60000,
};

/**
 * 优先级：DEFAULTS < ~/.mo-agent/config.json < 环境变量 < 命令行参数。
 * 配置文件坏了不崩：stderr 一行警告，按剩下的值继续。
 */
export function loadConfig(argv = [], options = {}) {
  const env = options.env || process.env;
  const cfg = Object.assign({}, DEFAULTS);

  if (env.DSH_HOME) cfg.dshHome = String(env.DSH_HOME);
  if (env.DSH_WEB_URL) cfg.dshBaseUrl = String(env.DSH_WEB_URL);

  const file = readGlobalConfig({ home: options.home, env });
  for (const warning of file.warnings) process.stderr.write("[W_CONFIG] " + warning + "\n");
  for (const [key, value] of Object.entries(file.values)) {
    // 只认 daemon 自己有的键：config.json 里的 CLI 键（recallLimit 等）不往这里塞
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) cfg[key] = value;
  }

  if (env.MO_AGENT_PORT) cfg.port = Number(env.MO_AGENT_PORT);
  if (env.MO_AGENT_PIN) cfg.pin = String(env.MO_AGENT_PIN);
  if (env.MO_AGENT_NO_AUTH === "1") cfg.authRequired = false;
  if (env.MO_AGENT_POLL) cfg.pollMs = Number(env.MO_AGENT_POLL);
  if (env.MO_AGENT_LOG_LEVEL) cfg.logLevel = String(env.MO_AGENT_LOG_LEVEL);
  if (env.MO_AGENT_APPROVAL_GRACE_MS) cfg.approvalNoClientGraceMs = Number(env.MO_AGENT_APPROVAL_GRACE_MS);

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--port") cfg.port = Number(next());
    else if (a === "--host") cfg.host = String(next());
    else if (a === "--pin") cfg.pin = String(next());
    else if (a === "--dsh-home") cfg.dshHome = String(next());
    else if (a === "--dsh-url") cfg.dshBaseUrl = String(next());
    else if (a === "--poll") cfg.pollMs = Number(next());
    else if (a === "--window") cfg.activeWindowMs = Number(next()) * 3600 * 1000;
    else if (a === "--transcript-window") cfg.transcriptWindowMs = Number(next()) * 3600 * 1000;
    else if (a === "--max-sessions") cfg.maxSessions = Number(next());
    else if (a === "--no-auth") cfg.authRequired = false;
    else if (a === "--log-level") cfg.logLevel = String(next());
    else if (a === "--approval-grace") cfg.approvalNoClientGraceMs = Number(next()) * 1000;
  }
  return cfg;
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
