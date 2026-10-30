#!/usr/bin/env node
// 决定这次桌面构建要不要把 host/notify-defaults.json（含 HMS App Secret）打进 runtime。
//
// 规则：
//   MO_AGENT_DESKTOP_HMS=0      从不打包
//   MO_AGENT_DESKTOP_HMS=1      打包；文件不存在直接失败（明确要求就明确报错）
//   未设置（auto）              非 CI 且文件存在才打包；CI 一律不打包
//
//   node scripts/desktop-hms.mjs   → 输出 include 或 skip:<原因>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
export const DEFAULTS_FILE = path.join(ROOT, "host", "notify-defaults.json");

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/** @returns {{include:boolean, reason:string, missing?:boolean}} */
export function decideHms({ env = process.env, exists = false } = {}) {
  const raw = String(env.MO_AGENT_DESKTOP_HMS ?? "").trim().toLowerCase();

  if (FALSY.has(raw)) return { include: false, reason: "MO_AGENT_DESKTOP_HMS=0" };

  if (TRUTHY.has(raw)) {
    if (!exists) return { include: false, missing: true, reason: "MO_AGENT_DESKTOP_HMS=1，但 host/notify-defaults.json 不存在" };
    return { include: true, reason: "MO_AGENT_DESKTOP_HMS=1" };
  }

  if (!exists) return { include: false, reason: "host/notify-defaults.json 不存在" };

  const isCi = Boolean(env.CI) && String(env.CI).toLowerCase() !== "false";
  if (isCi) return { include: false, reason: "CI 环境一律不带 HMS 密钥" };

  return { include: true, reason: "本地构建且配置存在" };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const decision = decideHms({ exists: fs.existsSync(DEFAULTS_FILE) });
  if (decision.missing) {
    console.error("[build] !! " + decision.reason);
    console.error("[build] !! 要么去掉 MO_AGENT_DESKTOP_HMS=1，要么先准备好这个文件");
    process.exit(2);
  }
  console.log(decision.include ? "include" : "skip:" + decision.reason);
}
