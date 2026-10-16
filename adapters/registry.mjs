import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "./claude-code.mjs";
import { AgentMonitor } from "./dsh-monitor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 读取声明式 Agent 档案。加一个 Agent = 加一个 json，不改代码。 */
export function loadProfiles(dir) {
  const base = dir || path.join(here, "profiles");
  const profiles = [];
  let names = [];
  try {
    names = fs.readdirSync(base).filter((n) => n.endsWith(".json"));
  } catch (error) {
    return profiles;
  }
  for (const name of names) {
    try {
      profiles.push(JSON.parse(fs.readFileSync(path.join(base, name), "utf8")));
    } catch (error) {
      /* 跳过坏档案 */
    }
  }
  return profiles;
}

/** 按档案实例化已启用的适配器。 */
export function createAdapters(options) {
  const opts = options || {};
  const hub = opts.hub;
  const log = opts.log;
  const config = opts.config || {};
  const profiles = opts.profiles || loadProfiles();
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const adapters = [];

  const dshProfile = byId.get("dsh");
  if (dshProfile && dshProfile.enabled !== false && opts.dsh) {
    const monitor = new AgentMonitor({
      hub,
      dsh: opts.dsh,
      log,
      pollMs: config.pollMs,
      historySize: config.historySize,
      activeWindowMs: config.activeWindowMs,
      maxSessions: config.maxSessions,
    });
    monitor.name = "dsh";
    adapters.push(monitor);
  }

  const ccProfile = byId.get("claude-code");
  if (ccProfile && ccProfile.enabled !== false) {
    adapters.push(
      new ClaudeCodeAdapter({
        hub,
        log,
        profile: ccProfile,
        pollMs: config.transcriptPollMs,
        activeWindowMs: config.transcriptWindowMs || 72 * 3600 * 1000,
      })
    );
  }

  return { adapters, profiles };
}
