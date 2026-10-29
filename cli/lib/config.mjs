/**
 * 全局配置：~/.mo-agent/config.json（可用 MO_AGENT_CONFIG 覆盖路径）。
 *
 * 只放"全局、机器级"的键：端口、监听地址、日志级别、召回条数、记忆库路径。
 * 默认执行者 / 默认终端仍然在 workers.json / terminals.json，不重复存。
 *
 * 读取优先级（后者覆盖前者）：
 *   DEFAULTS < config.json < 环境变量（命令行参数只对 daemon 有意义，见 host/config.mjs）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { readJsonSafe, writeJsonAtomic } from "./fsx.mjs";
import { moHome } from "./paths.mjs";

const LOG_LEVELS = ["debug", "info", "warn", "error"];

function parseText(value) {
  const text = String(value ?? "").trim();
  if (!text) return { ok: false, message: "需要非空字符串" };
  return { ok: true, value: text };
}

/** 展开 ~ / ~/xxx；其它原样返回 */
export function expandHomePath(value) {
  const text = String(value ?? "").trim();
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function parsePath(value) {
  // 空字符串 = 用默认目录，允许
  return { ok: true, value: expandHomePath(value) };
}

function parsePort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return { ok: false, message: "需要 1–65535 的整数" };
  const number = Number(text);
  if (number < 1 || number > 65535) return { ok: false, message: "需要 1–65535 的整数" };
  return { ok: true, value: number };
}

function parseBoolean(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(text)) return { ok: true, value: true };
  if (["false", "0", "no", "n", "off"].includes(text)) return { ok: true, value: false };
  return { ok: false, message: "需要 true / false" };
}

function parsePoll(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return { ok: false, message: "需要 ≥ 100 的整数（毫秒）" };
  const number = Number(text);
  if (number < 100) return { ok: false, message: "需要 ≥ 100 的整数（毫秒）" };
  return { ok: true, value: number };
}

function parseLogLevel(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!LOG_LEVELS.includes(text)) return { ok: false, message: "需要 " + LOG_LEVELS.join(" / ") };
  return { ok: true, value: text };
}

function parseRecall(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return { ok: false, message: "需要 0–20 的整数" };
  const number = Number(text);
  if (number < 0 || number > 20) return { ok: false, message: "需要 0–20 的整数" };
  return { ok: true, value: number };
}

/** 键表：默认值 + 校验 + 说给用户看的范围 + 对应的环境变量 */
export const CONFIG_KEYS = [
  { key: "host", type: "string", default: "0.0.0.0", range: "非空字符串", env: "MO_AGENT_HOST", parse: parseText },
  { key: "port", type: "number", default: 7788, range: "1–65535 的整数", env: "MO_AGENT_PORT", parse: parsePort },
  { key: "authRequired", type: "boolean", default: true, range: "true / false", env: "MO_AGENT_AUTH_REQUIRED", parse: parseBoolean },
  { key: "pollMs", type: "number", default: 1500, range: "≥ 100 的整数（毫秒）", env: "MO_AGENT_POLL", parse: parsePoll },
  { key: "logLevel", type: "string", default: "info", range: LOG_LEVELS.join(" / "), env: "MO_AGENT_LOG_LEVEL", parse: parseLogLevel },
  { key: "recallLimit", type: "number", default: 5, range: "0–20 的整数", env: "MO_RECALL_LIMIT", parse: parseRecall },
  { key: "memoryPath", type: "string", default: "", range: "路径，空字符串表示默认目录", env: "MO_AGENT_MEMORY", parse: parsePath },
];

const KEY_MAP = new Map(CONFIG_KEYS.map((spec) => [spec.key, spec]));

export function configKey(key) {
  return KEY_MAP.get(String(key)) || null;
}

export function configFile({ home, env = process.env } = {}) {
  if (env.MO_AGENT_CONFIG) return path.resolve(env.MO_AGENT_CONFIG);
  return path.join(home || moHome(env), "config.json");
}

function readRaw(file) {
  const value = readJsonSafe(file, undefined);
  if (value === undefined) return { raw: {}, broken: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { raw: {}, broken: true };
  return { raw: value, broken: false };
}

/**
 * 读配置。坏 JSON / 非法字段不抛异常：收进 warnings，调用方决定怎么提示。
 * @returns {{file: string, exists: boolean, values: object, present: string[], warnings: string[]}}
 */
export function readGlobalConfig({ home, env = process.env } = {}) {
  const file = configFile({ home, env });
  const warnings = [];
  const exists = fs.existsSync(file);
  let values = {};
  let present = [];
  if (exists) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      warnings.push("config.json 不是合法 JSON：" + file + "（已忽略，按默认值继续）");
      raw = null;
    }
    if (raw !== null && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
      warnings.push("config.json 顶层不是对象（已忽略，按默认值继续）");
      raw = null;
    }
    if (raw) {
      present = Object.keys(raw);
      for (const spec of CONFIG_KEYS) {
        if (raw[spec.key] === undefined) continue;
        const parsed = spec.parse(raw[spec.key]);
        if (!parsed.ok) {
          warnings.push(spec.key + " 非法（" + parsed.message + "），已忽略");
          continue;
        }
        values[spec.key] = parsed.value;
      }
    }
  }
  return { file, exists, values, present, warnings };
}

/**
 * 写配置：patch 里 value === undefined 表示删掉该键（回到默认）。
 * 保留文件里不认识的键，不擅自清理用户手写的东西。
 */
export function writeGlobalConfig({ home, env = process.env, patch = {} } = {}) {
  const file = configFile({ home, env });
  const { raw } = readRaw(file);
  const next = { ...raw };
  for (const [key, value] of Object.entries(patch)) {
    const spec = configKey(key);
    if (!spec) {
      throw new MoError("E_USAGE", "未知配置键：" + key, { hint: "mo config list 查看可用键" });
    }
    if (value === undefined || value === null) {
      delete next[key];
      continue;
    }
    const parsed = spec.parse(value);
    if (!parsed.ok) {
      throw new MoError("E_USAGE", "非法值：" + key + "=" + String(value) + "（" + parsed.message + "）", {
        hint: "取值范围：" + spec.range,
      });
    }
    next[key] = parsed.value;
  }
  writeJsonAtomic(file, next);
  return { file, values: next };
}

function envValue(spec, env) {
  if (spec.key === "authRequired" && env.MO_AGENT_NO_AUTH === "1") return { present: true, raw: "false" };
  const raw = env[spec.env];
  if (raw === undefined || raw === "") return { present: false, raw: "" };
  return { present: true, raw };
}

/**
 * 每个键的生效值与来源。source ∈ default | file | env。
 * daemon 的 argv 只由 host/config.mjs 处理，这里不显示。
 */
export function effectiveConfig({ home, env = process.env } = {}) {
  const read = readGlobalConfig({ home, env });
  const result = {};
  for (const spec of CONFIG_KEYS) {
    let value = spec.default;
    let source = "default";
    if (Object.prototype.hasOwnProperty.call(read.values, spec.key)) {
      value = read.values[spec.key];
      source = "file";
    }
    const fromEnv = envValue(spec, env);
    if (fromEnv.present) {
      const parsed = spec.parse(fromEnv.raw);
      if (parsed.ok) {
        value = parsed.value;
        source = "env";
      }
    }
    result[spec.key] = { value, source, default: spec.default };
  }
  return result;
}