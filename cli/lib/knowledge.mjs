import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { parseKnowledgeFile } from "../../core/knowledge/entry.mjs";
import { recall } from "../../core/knowledge/recall.mjs";

/**
 * 记忆库的 IO 边界：找目录、读文件、把系统错误翻译成稳定错误码。
 * B10.5 / I9：读不了就报 E_MEMORY_UNAVAILABLE，绝不静默返回空。
 *
 * 目录叫 memory（跟 `mo memory` 对齐）；老版本的 knowledge/ 仍能读，
 * 只是会带一条 W_MEMORY_LEGACY_DIR 提醒用 `mo memory migrate` 搬过来。
 */

const SCOPES = {
  "preferences.md": "preferences",
  "preferences": "preferences",
  "pitfalls": "pitfalls",
  "decisions": "decisions",
};

export function memoryDir(home, env = process.env) {
  if (env.MO_AGENT_MEMORY) {
    return { dir: path.resolve(env.MO_AGENT_MEMORY), explicit: true, source: "env" };
  }
  if (env.MO_AGENT_KNOWLEDGE) {
    return { dir: path.resolve(env.MO_AGENT_KNOWLEDGE), explicit: true, source: "legacy-env" };
  }

  const next = path.join(home, "memory");
  const legacy = path.join(home, "knowledge");
  // 老安装：只有 knowledge/ 时才继续用它，避免用户"换个命令就找不到记忆"
  if (!fs.existsSync(next) && fs.existsSync(legacy)) {
    return { dir: legacy, explicit: false, source: "legacy", target: next };
  }
  return { dir: next, explicit: false, source: "default" };
}



function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new MoError("E_MEMORY_UNAVAILABLE", "知识库不可读：" + dir + "（" + error.code + "）", {
      hint: "检查目录权限，或把 MO_AGENT_KNOWLEDGE 指到别处",
    });
  }
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new MoError("E_MEMORY_UNAVAILABLE", "知识文件不可读：" + file + "（" + error.code + "）", {
      hint: "检查文件权限",
    });
  }
}

/** 跳过 _template.md / README.md：模板不是知识 */
function usable(name) {
  if (!name.toLowerCase().endsWith(".md")) return false;
  if (name.startsWith("_")) return false;
  if (name.toLowerCase() === "readme.md") return false;
  return true;
}

function collect(dir, scope, prefix = "") {
  const found = [];
  const entries = readdirSafe(dir);
  if (!entries) return found;
  for (const dirent of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!usable(dirent.name)) continue;
    if (dirent.isFile()) {
      found.push({ scope, name: path.join(prefix, dirent.name), file: path.join(dir, dirent.name) });
    }
  }
  return found;
}

/**
 * @returns {{ok: boolean, dir: string, exists: boolean, entries: object[], warnings: string[]}}
 */
export function loadKnowledge({ home, env = process.env }) {
  const { dir, explicit, source, target } = memoryDir(home, env);
  const warnings = [];
  // 读的是老目录：能用，但要让用户知道该搬了
  if (source === "legacy" || source === "legacy-env") warnings.push("W_MEMORY_LEGACY_DIR");

  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new MoError("E_MEMORY_UNAVAILABLE", "知识库不可读：" + dir + "（" + error.code + "）");
    }
  }

  if (!stat) {
    // 显式指定的路径不存在 = 配置错了，必须吵；默认路径不存在 = 还没初始化，提示即可
    if (explicit) {
      const name = source === "legacy-env" ? "MO_AGENT_KNOWLEDGE" : "MO_AGENT_MEMORY";
      throw new MoError("E_MEMORY_UNAVAILABLE", name + " 指向的记忆库不存在：" + dir, {
        hint: "去掉该环境变量，或先运行 mo memory init",
      });
    }
    warnings.push("W_MEMORY_EMPTY");
    return { ok: true, dir, source, exists: false, entries: [], warnings, legacyTarget: target || null };
  }

  if (!stat.isDirectory()) {
    throw new MoError("E_MEMORY_UNAVAILABLE", "记忆库路径不是目录：" + dir);
  }

  const files = [];
  const rootEntries = readdirSafe(dir) || [];
  for (const dirent of rootEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!dirent.isFile() || !usable(dirent.name)) continue;
    const scope = SCOPES[dirent.name] || "decisions";
    files.push({ scope, name: dirent.name, file: path.join(dir, dirent.name) });
  }
  for (const folder of ["preferences", "pitfalls", "decisions"]) {
    const scope = SCOPES[folder];
    for (const item of collect(path.join(dir, folder), scope, folder)) files.push(item);
  }

  const entries = [];
  for (const item of files) {
    const parsed = parseKnowledgeFile({ scope: item.scope, name: item.name, text: readFileSafe(item.file) });
    for (const entry of parsed) entries.push({ ...entry, path: item.file });
  }

  if (!entries.length) warnings.push("W_MEMORY_EMPTY");
  return { ok: true, dir, source, exists: true, entries, warnings, legacyTarget: target || null };
}

/** 用卡片内容当查询：标题 + 正文里的关键词都会参与打分 */
export function cardQuery(card) {
  return [card.meta.title, card.body].filter(Boolean).join("\n");
}

export function recallLimit(env = process.env) {
  const parsed = Number(env.MO_RECALL_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 20) : 5;
}

/**
 * 派单前的召回。读不到知识库时抛 MoError，由调用方决定是警告还是失败。
 */
export function recallKnowledge({ home, env = process.env, query, limit, scopes, includeAll = false }) {
  const loaded = loadKnowledge({ home, env });
  const effectiveLimit = includeAll ? loaded.entries.length : limit || recallLimit(env);
  const result = recall(loaded.entries, { query, limit: effectiveLimit, scopes });
  return { ...result, dir: loaded.dir, warnings: loaded.warnings, total: loaded.entries.length };
}
