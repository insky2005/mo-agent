import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * Qoder CN 的会话标题在它的 SQLite 里（main.sqlite 的 chat_sessions.title），
 * transcript 本身没有 ai-title。这里提供一个带缓存、带节流的只读读取器：
 *
 *   1. 优先 Node 内置 node:sqlite（Node >= 22.5，不额外起进程）；
 *   2. 退到本机 sqlite3 CLI（macOS 自带，Node 20 也能用）；
 *   3. 都没有就返回空，调用方退回「第一问 + 截断」。
 *
 * 默认 30 秒最多读一次，不阻塞轮询。
 */

const TITLE_LIMIT = 80;

export function normalizeTitle(value) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > TITLE_LIMIT ? text.slice(0, TITLE_LIMIT - 1) + "…" : text;
}

/** 行数组 -> Map<session_id, title>；非法行直接跳过。 */
export function normalizeRows(rows) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = row.session_id;
    const title = normalizeTitle(row.title);
    if (typeof id === "string" && id && title) map.set(id, title);
  }
  return map;
}

/** sqlite3 -json 的输出 -> Map<session_id, title>；坏输出一律当空。 */
export function parseTitles(output) {
  const text = String(output == null ? "" : output).trim();
  if (!text) return new Map();
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    return new Map();
  }
  return normalizeRows(rows);
}

/** 探测 Node 内置 sqlite；Node < 22.5 或没开 flag 时返回 null。 */
export function loadNodeSqlite() {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite");
    return mod && typeof mod.DatabaseSync === "function" ? mod : null;
  } catch (error) {
    return null;
  }
}

export function defaultDbPath(home) {
  const base = home || os.homedir();
  return path.join(base, "Library", "Application Support", "com.qodercn.app.stable", "main.sqlite");
}

/** 找一个可用的 sqlite3；找不到就返回空字符串（功能降级，不报错）。 */
export function findSqlite3(env, exists) {
  const check = exists || fs.existsSync;
  const e = env || process.env;
  const candidates = [
    e.MO_AGENT_SQLITE3,
    "/usr/bin/sqlite3",
    "/opt/homebrew/bin/sqlite3",
    "/usr/local/bin/sqlite3",
  ].filter(Boolean);
  for (const item of candidates) {
    try {
      if (check(item)) return item;
    } catch (error) {
      /* 忽略权限问题 */
    }
  }
  return "";
}

const SQL = "select session_id, title from chat_sessions where deleted_at is null and title is not null and title <> ''";

/** 用内置 node:sqlite 同步读一次，读完立即关闭。 */
function readWithNodeSqlite(mod, dbPath) {
  const db = new mod.DatabaseSync(dbPath, { readOnly: true });
  try {
    return normalizeRows(db.prepare(SQL).all());
  } finally {
    try {
      db.close();
    } catch (error) {
      /* 关闭失败无所谓 */
    }
  }
}

/**
 * @param {object} options
 * @param {string} [options.dbPath]      main.sqlite 路径
 * @param {string} [options.sqlitePath]  sqlite3 可执行文件
 * @param {object} [options.nodeSqlite]  node:sqlite 模块；缺省自动探测，null 表示禁用
 * @param {number} [options.intervalMs]  刷新间隔，默认 30s
 * @param {Function} [options.run]       测试注入：等价于 execFileSync
 * @param {Function} [options.now]       测试注入
 */
export function createTitleSource(options) {
  const opts = options || {};
  const dbPath = opts.dbPath || defaultDbPath();
  const intervalMs = typeof opts.intervalMs === "number" ? opts.intervalMs : 30 * 1000;
  const now = opts.now || Date.now;
  const run = opts.run || execFileSync;
  const sqlitePath = opts.sqlitePath === undefined ? findSqlite3() : opts.sqlitePath;
  const nodeSqlite = opts.nodeSqlite === undefined ? loadNodeSqlite() : opts.nodeSqlite;
  const log = opts.log || { debug() {} };
  let cache = new Map();
  let lastAt = -Infinity;
  let warned = false;

  return {
    title(sessionId) {
      return cache.get(sessionId) || "";
    },
    size() {
      return cache.size;
    },
    refresh(force) {
      const at = now();
      if (!force && at - lastAt < intervalMs) return;
      lastAt = at;
      if (!fs.existsSync(dbPath)) {
        if (!warned) {
          warned = true;
          log.debug("找不到 Qoder CN 数据库，会话标题退回第一问: " + dbPath);
        }
        return;
      }
      // 首选 Node 内置 sqlite：不 spawn、不依赖外部命令。
      if (nodeSqlite) {
        try {
          cache = readWithNodeSqlite(nodeSqlite, dbPath);
          warned = false;
          return;
        } catch (error) {
          if (!warned) log.debug("node:sqlite 读取失败，改用 sqlite3 CLI: " + (error && error.message ? error.message : error));
        }
      }
      if (!sqlitePath) {
        if (!warned) {
          warned = true;
          log.debug("没有可用的 sqlite 后端，Qoder CN 会话标题退回第一问");
        }
        return;
      }
      try {
        const output = run(sqlitePath, ["-readonly", "-json", dbPath, SQL], {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 4 * 1024 * 1024,
        });
        cache = parseTitles(output);
        warned = false;
      } catch (error) {
        if (!warned) {
          warned = true;
          log.debug("读取 Qoder CN 会话标题失败: " + (error && error.message ? error.message : error));
        }
      }
    },
  };
}
