import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(here, "..", "adapters", "profiles");

/** 读取 Agent profile；找不到或坏文件返回 null，hook 仍按旧模式工作。 */
export function loadProfile(agentId, dir) {
  const base = dir || DEFAULT_DIR;
  const id = String(agentId || "claude-code").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!id) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(base, id + ".json"), "utf8"));
  } catch (error) {
    return null;
  }
}

/** profile.hooks.events 是厂商 hook 名 -> 规范事件的唯一映射。 */
export function mapHookEvent(profile, hookEvent) {
  const events = (profile && profile.hooks && profile.hooks.events) || {};
  return events[hookEvent] || "";
}

/**
 * 把 CLI 模式解析成规范事件：
 *  - event <HookEvent> [agent]：读 profile 映射（新方式）
 *  - permission / notify：兼容旧安装的 hook 命令
 */
export function hookTarget(mode, profile, hookEvent) {
  if (mode === "permission") return "approval.pending";
  if (mode === "notify") return "notice";
  if (mode === "event") return mapHookEvent(profile, hookEvent);
  return "";
}
