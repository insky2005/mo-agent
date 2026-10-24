/**
 * 知识召回：纯打分，不碰文件系统。见 docs/spec/workbench-flow.md §7.2 / B10。
 *
 * 打分刻意保持可解释：命中哪里就加哪里的权重，不引入向量与外部依赖。
 * - 标题 4 分
 * - trigger / tags 3 分
 * - 正文 1 分（同一 token 只算一次，避免长条目靠堆字赢）
 */

const WEIGHT = { title: 4, trigger: 3, tags: 3, body: 1 };

/** ASCII 词按词切，中文按二元组切（中文没有空格，二元组命中率最稳） */
export function tokenize(text) {
  const source = String(text || "").toLowerCase();
  const tokens = new Set();

  for (const matched of source.matchAll(/[a-z0-9][a-z0-9_+.-]{1,}/g)) tokens.add(matched[0]);
  for (const matched of source.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = matched[0];
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2));
    if (run.length <= 6) tokens.add(run);
  }

  return [...tokens].filter((token) => token.length > 0);
}

function contains(haystack, token) {
  return haystack.includes(token);
}

export function scoreEntry(entry, tokens) {
  const fields = {
    title: String(entry.title || "").toLowerCase(),
    trigger: (entry.trigger || []).join(" ").toLowerCase(),
    tags: (entry.tags || []).join(" ").toLowerCase(),
    body: String(entry.body || "").toLowerCase(),
  };

  const hits = [];
  let score = 0;
  for (const token of tokens) {
    for (const field of ["title", "trigger", "tags", "body"]) {
      if (contains(fields[field], token)) {
        score += WEIGHT[field];
        hits.push(field + ":" + token);
      }
    }
  }
  return { score, hits };
}

/**
 * @param {object[]} entries parseKnowledgeFile 的结果
 * @param {{query?: string, limit?: number, scopes?: string[], minScore?: number}} options
 */
export function recall(entries, options = {}) {
  const query = String(options.query || "").trim();
  const limit = Math.max(1, Number(options.limit) || 5);
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 1;
  const scopes = options.scopes && options.scopes.length ? new Set(options.scopes) : null;

  const pool = scopes ? entries.filter((entry) => scopes.has(entry.scope)) : entries;
  const tokens = tokenize(query);
  if (!tokens.length) return { query, tokens: [], matched: [], total: pool.length };

  const matched = pool
    .map((entry) => ({ entry, ...scoreEntry(entry, tokens) }))
    .filter((item) => item.score >= minScore)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.entry.id.localeCompare(right.entry.id);
    })
    .slice(0, limit)
    .map((item) => ({ ...item.entry, score: item.score, hits: item.hits }));

  return { query, tokens, matched, total: pool.length };
}

/** 派单信封里的注入块；没有命中时返回空串，由调用方决定是否留白 */
export function formatKnowledgeBlock(matched, { maxBody = 240 } = {}) {
  if (!matched || !matched.length) return "";
  const order = ["preferences", "pitfalls", "decisions"];
  const label = { preferences: "偏好", pitfalls: "避坑", decisions: "决策" };
  const lines = ["## 卡片附带的知识（自动注入）", ""];

  for (const scope of order) {
    const items = matched.filter((entry) => entry.scope === scope);
    if (!items.length) continue;
    lines.push("### " + (label[scope] || scope));
    for (const entry of items) {
      const oneLine = String(entry.body || "").replace(/\s*\n\s*/g, " ").trim();
      const clipped = oneLine.length > maxBody ? oneLine.slice(0, maxBody) + "…" : oneLine;
      lines.push("- [" + entry.id + "] " + entry.title + (clipped ? "：" + clipped : ""));
    }
    lines.push("");
  }

  const rest = matched.filter((entry) => !order.includes(entry.scope));
  if (rest.length) {
    lines.push("### 其它");
    for (const entry of rest) lines.push("- [" + entry.id + "] " + entry.title);
    lines.push("");
  }

  return lines.join("\n");
}
