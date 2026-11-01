import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Node 版本解析。
 *
 * Router 的运行时是被 pin 死的依赖，它对 Node 的最低版本由运行时自己声明
 * （Pi 1.3.0 要 >= 22.19.0），不能拿 mo 自己的 Node 下限去假定。
 */

export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

/** 只支持 ">=x.y.z" 与裸版本；这是 manifest 里唯一会出现的两种写法 */
export function satisfies(actual, requirement) {
  const text = String(requirement || "").trim();
  if (!text) return true;
  const greater = text.startsWith(">=");
  const target = greater ? text.slice(2) : text;
  const order = compareVersions(actual, target);
  if (order === null) return false;
  return greater ? order >= 0 : order === 0;
}

/** 候选 Node 路径，按优先级：显式覆盖 > Pi 自带 Node > 当前进程 > PATH */
export function nodeCandidates(env) {
  const list = [];
  if (env.MO_ROUTER_NODE) list.push({ path: env.MO_ROUTER_NODE, source: "MO_ROUTER_NODE" });
  const piNode = path.join(
    env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "pi-node",
    "current",
    "bin",
    "node"
  );
  list.push({ path: piNode, source: "pi-node" });
  if (process.execPath && !/^(bun|node)$/i.test(path.basename(process.execPath))) {
    // mo 是单文件二进制时 execPath 不是 node，跳过
  } else {
    list.push({ path: process.execPath, source: "self" });
  }
  list.push({ path: "node", source: "PATH" });
  return list;
}

function versionOf(candidate) {
  if (candidate.path === process.execPath) return { ok: true, version: process.versions.node };
  try {
    const result = spawnSync(candidate.path, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return { ok: false };
    const text = String(result.stdout || "").trim().replace(/^v/, "");
    return parseVersion(text) ? { ok: true, version: text } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * 找一个满足运行时要求的 Node。
 * @returns {{ok: true, path: string, version: string, source: string} | {ok: false, required: string, found: string[]}}
 */
export function resolveNode(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const required = opts.required || ">=22.19.0";
  const found = [];

  for (const candidate of nodeCandidates(env)) {
    if (candidate.path !== "node" && !fs.existsSync(candidate.path)) continue;
    const info = versionOf(candidate);
    if (!info.ok) {
      found.push(candidate.source + "（不可用）");
      continue;
    }
    found.push(candidate.source + " " + info.version);
    if (satisfies(info.version, required)) {
      return { ok: true, path: candidate.path, version: info.version, source: candidate.source };
    }
  }
  return { ok: false, required, found };
}
