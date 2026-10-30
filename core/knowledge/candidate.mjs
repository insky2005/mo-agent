/**
 * 记忆候选：校验、冲突检测、渲染成知识条目。纯逻辑，不碰文件系统。
 * 见 docs/spec/workbench-flow.md B10.1–B10.4、§7.4。
 */
import { tokenize } from "./recall.mjs";

export const CANDIDATE_SCOPES = ["preferences", "pitfalls", "decisions"];

const TITLE_LIMIT = 120;
const OVERLAP_THRESHOLD = 0.6;
// 太短的正文（"改完再跑" 这类）算重合度没有意义，直接不判
const MIN_BODY_TOKENS = 8;

function asList(value) {
  if (value === undefined || value === null || value === "") return [];
  const items = Array.isArray(value) ? value : String(value).split(/[,，、\n]/);
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}

/** 把外部输入（回执里的 pitfalls、命令行 JSON）收敛成候选形状 */
export function normalizeCandidate(input = {}) {
  return {
    scope: String(input.scope || "pitfalls").trim(),
    title: String(input.title || input.symptom || "").trim(),
    trigger: asList(input.trigger ?? input.triggers ?? input.when),
    tags: asList(input.tags),
    body: String(input.body || "").trim(),
    source: String(input.source || "proposal"),
    taskId: input.taskId ? String(input.taskId) : null,
    project: input.project ? String(input.project) : null,
    ref: input.ref ? String(input.ref) : null,
  };
}

/** B10.3：缺触发条件不是警告，是拒收 */
export function validateCandidate(candidate) {
  const errors = [];
  if (!CANDIDATE_SCOPES.includes(candidate.scope)) {
    errors.push("scope 必须是 " + CANDIDATE_SCOPES.join(" / ") + "，当前：" + (candidate.scope || "（空）"));
  }
  if (!candidate.title) errors.push("缺少标题");
  if (candidate.title && candidate.title.length > TITLE_LIMIT) errors.push("标题超过 " + TITLE_LIMIT + " 字");
  if (!candidate.trigger.length) errors.push("缺少触发条件（trigger）");
  if (!candidate.body) errors.push("缺少正文");
  return { ok: errors.length === 0, errors };
}

function normalizeTitle(title) {
  return String(title || "").toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * B10.4：冲突不自动覆盖，交给人与候选对比后裁决。
 * 优先按同标题判重，再看正文重合度。
 */
export function detectConflict(candidate, entries, { threshold = OVERLAP_THRESHOLD } = {}) {
  const pool = entries.filter((entry) => entry.scope === candidate.scope);
  const title = normalizeTitle(candidate.title);
  const sameTitle = pool.find((entry) => normalizeTitle(entry.title) === title);
  if (sameTitle) return { kind: "same-title", entry: sameTitle, similarity: 1 };

  // 只比正文：标题由上面的同标题规则覆盖，掺进标题会稀释真正的内容重合度
  const tokens = tokenize(candidate.body);
  if (tokens.length < MIN_BODY_TOKENS) return null;
  let best = null;
  for (const entry of pool) {
    const other = tokenize(entry.body);
    if (other.length < MIN_BODY_TOKENS) continue;
    const similarity = jaccard(tokens, other);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { kind: "overlap", entry, similarity };
    }
  }
  return best;
}

/** 与知识库文件同一套 markdown 格式，接受后可以直接被召回 */
export function renderEntry(candidate) {
  const lines = ["## " + candidate.title, ""];
  lines.push("- trigger: " + candidate.trigger.join(", "));
  if (candidate.tags.length) lines.push("- tags: " + candidate.tags.join(", "));
  lines.push("", candidate.body.trim(), "");
  return lines.join("\n");
}

/** 落到哪个文件：偏好集中一个文件，避坑/决策一条一个文件 */
export function targetFileName(candidate) {
  if (candidate.scope === "preferences") return "preferences.md";
  const slug = String(candidate.title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return candidate.scope + "/" + (slug || "entry") + ".md";
}

export function describeConflict(conflict) {
  if (!conflict) return null;
  const label = conflict.kind === "same-title" ? "同标题" : "正文高度重合";
  return {
    kind: conflict.kind,
    label,
    similarity: Number(conflict.similarity.toFixed(2)),
    existing: {
      id: conflict.entry.id,
      title: conflict.entry.title,
      body: conflict.entry.body,
      path: conflict.entry.path || null,
    },
  };
}
