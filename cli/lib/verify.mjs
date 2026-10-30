import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyItems } from "../../core/tasks/card.mjs";

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const OUTPUT_LIMIT = 2000;

/**
 * 执行任务卡上的验收项。纯 IO，由 cli 层负责。
 *
 * 规则（见 docs/spec/workbench-flow.md §6.8）：
 * - run: <命令>              在项目根用 /bin/sh -c 执行，退出码 0 通过；超时算失败
 * - check: <路径> 存在        文件存在通过
 * - check: <路径> 包含 <文本> 文件内容包含文本通过
 * - human: <说明>             不执行，交给人工确认
 * - 其它形式                   无法判定，归入 needs_human
 */
export function runVerify({ card, root, timeoutMs } = {}) {
  const meta = card && card.meta ? card.meta : card || {};
  const items = verifyItems(meta);
  const limit = resolveVerifyTimeout(timeoutMs);
  const projectRoot = root || process.cwd();

  const results = items.map((item) => evaluate(item, projectRoot, limit));
  const needsHuman = results.some((result) => result.kind === "human" || result.kind === "unknown");
  const ok = results.length > 0 && results.every((result) => result.ok);
  return { ok, results, needsHuman };
}

export function resolveVerifyTimeout(timeoutMs, env = process.env) {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
  const raw = Number(env.MO_VERIFY_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TIMEOUT_MS;
}

/** 把结果压缩成账本 payload：不落完整的命令输出。 */
export function verifyPayload(outcome) {
  if (!outcome) return undefined;
  return {
    ok: outcome.ok,
    needsHuman: outcome.needsHuman,
    results: outcome.results.map((result) => ({
      item: result.item,
      kind: result.kind,
      ok: result.ok,
      detail: result.detail,
      durationMs: result.durationMs,
    })),
  };
}

/** 有失败项（human / unknown 不算失败，只算需要人）。 */
export function hasVerifyFailure(results) {
  return results.some((result) => !result.ok && result.kind !== "human" && result.kind !== "unknown");
}

function scalarValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeItem(raw) {
  if (raw && typeof raw === "object") {
    // frontmatter 会把 true / false 解析成布尔值，这里统一按字符串解释
    const run = scalarValue(raw.run);
    const check = scalarValue(raw.check);
    const human = scalarValue(raw.human);
    if (run) return { kind: "run", value: run, item: "run: " + run };
    if (check) return { kind: "check", value: check, item: "check: " + check };
    if (human) return { kind: "human", value: human, item: "human: " + human };
    return { kind: "unknown", value: JSON.stringify(raw), item: JSON.stringify(raw) };
  }

  const text = String(raw ?? "").trim();
  const matched = /^(run|check|human):\s*([\s\S]*)$/.exec(text);
  if (matched && matched[2].trim()) {
    return { kind: matched[1], value: matched[2].trim(), item: matched[1] + ": " + matched[2].trim() };
  }
  return { kind: "unknown", value: text, item: text };
}

function evaluate(raw, root, timeoutMs) {
  const normalized = normalizeItem(raw);
  const started = Date.now();
  const finish = (ok, detail) => ({
    item: normalized.item,
    kind: normalized.kind,
    ok,
    detail,
    durationMs: Date.now() - started,
  });

  if (normalized.kind === "human") {
    return finish(false, "需要人工确认：" + normalized.value);
  }
  if (normalized.kind === "unknown") {
    return finish(false, "无法判定：" + (normalized.item || "空验收项"));
  }
  if (normalized.kind === "run") {
    return finish(...runCommand(normalized.value, root, timeoutMs));
  }

  const parsed = parseCheck(normalized.value);
  if (!parsed) {
    return {
      item: normalized.item,
      kind: "unknown",
      ok: false,
      detail: "无法判定的 check：" + normalized.value + "（支持 \"<路径> 存在\"、\"<路径> 包含 <文本>\"）",
      durationMs: Date.now() - started,
    };
  }

  const file = path.resolve(root, parsed.path);
  if (parsed.mode === "exists") {
    return finish(fs.existsSync(file), fs.existsSync(file) ? "文件存在" : "文件不存在：" + parsed.path);
  }

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return finish(false, "读取失败：" + parsed.path + "（" + (error && error.code ? error.code : String(error)) + "）");
  }
  if (!text.includes(parsed.text)) {
    return finish(false, "内容不包含：" + parsed.text);
  }
  return finish(true, "内容包含：" + parsed.text);
}

function parseCheck(value) {
  const exists = /^(.+?)\s+存在$/.exec(value);
  if (exists) return { mode: "exists", path: exists[1].trim() };

  const contains = /^(.+?)\s+包含\s+([\s\S]+)$/.exec(value);
  if (contains) return { mode: "contains", path: contains[1].trim(), text: contains[2] };
  return null;
}

function runCommand(command, root, timeoutMs) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error && result.error.code === "ETIMEDOUT") {
    return [false, "超时（" + timeoutMs + "ms）：" + command];
  }
  if (result.error) {
    return [false, "无法执行：" + String(result.error.message || result.error)];
  }

  const output = tail([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
  if (result.status === 0) {
    return [true, output ? "退出码 0：" + output : "退出码 0"];
  }

  const code = result.status === null ? "signal " + (result.signal || "-") : "退出码 " + result.status;
  return [false, code + (output ? "：" + output : "")];
}

function tail(text) {
  if (text.length <= OUTPUT_LIMIT) return text;
  return "…" + text.slice(-OUTPUT_LIMIT);
}