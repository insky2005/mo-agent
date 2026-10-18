import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 读取声明式 Agent 档案。加一个 Agent = 加一个 json + 一个 adapter 模块。 */
export function loadProfiles(dir) {
  const base = dir || path.join(here, "profiles");
  const profiles = [];
  let names = [];
  try {
    names = fs.readdirSync(base).filter((n) => n.endsWith(".json") && !n.startsWith("_"));
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

/**
 * 按 profile 动态加载 adapter：
 *  - profile.module 相对 adapters/ 目录；
 *  - profile.export 指定具名导出，缺省用 default；
 *  - capabilities.observe 含 native-api 但没有 DSH 依赖时跳过。
 *
 * 打包运行时会把 adapters/ 与 core/ 复制到 runtime，动态 import 从那里解析。
 */
export async function createAdapters(options) {
  const opts = options || {};
  const hub = opts.hub;
  const log = opts.log || (() => {});
  const config = opts.config || {};
  const profilesDir = opts.profilesDir || path.join(here, "profiles");
  const adaptersRoot = path.dirname(profilesDir);
  const profiles = opts.profiles || loadProfiles(profilesDir);
  const adapters = [];

  for (const profile of profiles) {
    if (!profile || profile.enabled === false) continue;
    const caps = profile.capabilities || {};
    const observe = Array.isArray(caps.observe) ? caps.observe : [];
    if (observe.includes("native-api") && !opts.dsh) continue;
    if (!profile.module) {
      log.warn("Agent " + (profile.id || "?") + " 缺少 module，已跳过");
      continue;
    }

    const target = path.resolve(adaptersRoot, profile.module);
    let Ctor;
    try {
      const mod = await import(pathToFileURL(target).href);
      Ctor = mod[profile.export || "default"] || mod.default;
    } catch (error) {
      log.warn("加载适配器失败 " + profile.id + ": " + (error && error.message ? error.message : error));
      continue;
    }
    if (typeof Ctor !== "function") {
      log.warn("适配器 " + profile.id + " 没有导出构造函数（export=" + (profile.export || "default") + "）");
      continue;
    }

    const isTranscript = !!(profile.session && profile.session.kind === "jsonl-transcript");
    const instance = new Ctor({
      hub,
      log,
      profile,
      config,
      dsh: opts.dsh,
      pollMs: isTranscript ? config.transcriptPollMs : config.pollMs,
      activeWindowMs: isTranscript ? (config.transcriptWindowMs || 72 * 3600 * 1000) : config.activeWindowMs,
      maxSessions: config.maxSessions,
      historySize: config.historySize,
    });
    if (!instance.name) instance.name = profile.id;
    adapters.push(instance);
  }

  return { adapters, profiles };
}
