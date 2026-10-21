import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function loadConfig(argv) {
  const cfg = Object.assign({}, DEFAULTS);
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
  if (process.env.MO_AGENT_PORT) cfg.port = Number(process.env.MO_AGENT_PORT);
  if (process.env.MO_AGENT_PIN) cfg.pin = String(process.env.MO_AGENT_PIN);
  if (process.env.MO_AGENT_NO_AUTH === "1") cfg.authRequired = false;
  if (process.env.MO_AGENT_POLL) cfg.pollMs = Number(process.env.MO_AGENT_POLL);
  if (process.env.MO_AGENT_LOG_LEVEL) cfg.logLevel = String(process.env.MO_AGENT_LOG_LEVEL);
  if (process.env.MO_AGENT_APPROVAL_GRACE_MS) cfg.approvalNoClientGraceMs = Number(process.env.MO_AGENT_APPROVAL_GRACE_MS);
  return cfg;
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
