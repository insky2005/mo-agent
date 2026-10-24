/**
 * 知识条目：把 knowledge/*.md 解析成条目。纯字符串处理，不碰文件系统。
 * 格式约定见 docs/spec/workbench-flow.md §12.2。
 *
 * 约定（尽量贴近人写笔记的习惯）：
 * - 文件开头可有 frontmatter（title / trigger / tags / scope），只做缺省值；
 * - 一个 `## 标题` 就是一个条目；没有二级标题时整个文件算一个条目；
 * - 条目开头的 `- trigger: a, b` / `- tags: x` / `- when: ...` 会被抽出来当匹配用的元数据；
 * - `# 一级标题` 只当条目标题提示，不进正文；
 * - 文件名以 `_` 开头（如 `_template.md`）由调用方跳过。
 */

const KEY_ALIASES = {
  trigger: "trigger",
  triggers: "trigger",
  when: "trigger",
  tag: "tags",
  tags: "tags",
  id: "id",
  title: "title",
};

const META_LINE = /^[-*]?\s*([A-Za-z_][A-Za-z0-9_-]*)\s*[:：]\s*(.*)$/;

/**
 * id 要能在信封里一眼认出来，所以保留中文，只清掉标点与空白。
 * 纯标点标题会得到空串，由 shortHash 兜底。
 */
export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function splitList(value) {
  return String(value)
    .split(/[,，、]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseFrontmatter(text) {
  const matched = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!matched) return { meta: {}, body: text };
  const meta = {};
  for (const raw of matched[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*[:：]\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = KEY_ALIASES[pair[1].toLowerCase()] || pair[1].toLowerCase();
    const value = pair[2].trim().replace(/^["']|["']$/g, "");
    meta[key] = key === "trigger" || key === "tags" ? splitList(value) : value;
  }
  return { meta, body: text.slice(matched[0].length) };
}

/** 按 `## ` 切段，跳过代码块里的伪标题 */
function splitSections(body) {
  const sections = [];
  let current = { title: null, lines: [] };
  sections.push(current);
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const heading = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    current.lines.push(line);
  }
  return sections;
}

/** 吃掉条目顶部的 `- trigger: …` 这类元数据行 */
function takeMeta(lines) {
  const meta = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      if (Object.keys(meta).length) continue;
      continue;
    }
    const pair = META_LINE.exec(line.trim());
    const key = pair && KEY_ALIASES[pair[1].toLowerCase()];
    if (!pair || !key) break;
    const value = pair[2].trim();
    if (key === "trigger" || key === "tags") {
      meta[key] = [...(meta[key] || []), ...splitList(value)];
    } else {
      meta[key] = value;
    }
    index += 1;
  }
  return { meta, rest: lines.slice(index) };
}

/** 文件顶部的 `# 标题` 只做标题提示，不参与正文 */
function takeHeading(body) {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => line.trim());
  if (index === -1) return { title: "", rest: "" };
  const matched = /^#\s+(.+?)\s*$/.exec(lines[index].trim());
  if (!matched) return { title: "", rest: body };
  return { title: matched[1].trim(), rest: [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n") };
}

function describe({ scope, name, title, lines }) {
  const trimmed = lines.join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
  return { scope, name, title, body: trimmed };
}

/**
 * @param {{scope: string, name: string, text: string, title?: string}} input
 *   name 是相对 knowledge 根的文件名（含子目录），用来生成稳定 id。
 * @returns {{id: string, scope: string, name: string, title: string, body: string,
 *            trigger: string[], tags: string[]}[]}
 */
export function parseKnowledgeFile({ scope, name, text, title: fileTitle }) {
  const source = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const { meta: fileMeta, body } = parseFrontmatter(source);
  const stem = name.split("/").pop().replace(/\.md$/i, "");
  const heading = takeHeading(body);
  const baseTitle = fileTitle || fileMeta.title || heading.title || stem;
  const entries = [];

  for (const section of splitSections(heading.rest)) {
    const title = section.title;
    const lines = section.lines;

    const taken = takeMeta(lines);
    const merged = describe({ scope, name, title: taken.meta.title || title, lines: taken.rest });
    if (!merged.title && !merged.body) continue;

    entries.push({
      ...merged,
      title: merged.title || baseTitle,
      trigger: dedupe([...(taken.meta.trigger || []), ...(fileMeta.trigger || [])]),
      tags: dedupe([...(taken.meta.tags || []), ...(fileMeta.tags || [])]),
      fileMeta,
    });
  }

  // 同一文件里同标题会产生同 id：补序号，保证 id 稳定且唯一
  const seen = new Map();
  return entries.map((entry) => {
    const base = entryId(scope, name, entry.title);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    const id = count === 1 ? base : base + "-" + count;
    return {
      id,
      scope: entry.scope,
      name: entry.name,
      title: entry.title,
      body: entry.body,
      trigger: entry.trigger,
      tags: entry.tags,
      meta: entry.fileMeta,
    };
  });
}

function dedupe(list) {
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

/** 中文标题 slug 为空时用稳定短哈希，保证 id 不随条目顺序变化 */
function shortHash(text) {
  let hash = 5381;
  for (const char of String(text)) hash = ((hash * 33) ^ char.codePointAt(0)) >>> 0;
  return hash.toString(36);
}

export function entryId(scope, name, title) {
  const stem = name.split("/").pop().replace(/\.md$/i, "");
  const tail = slug(title) || (title ? shortHash(title) : "") || slug(stem) || "entry";
  return scope + ":" + stem + "#" + tail;
}
