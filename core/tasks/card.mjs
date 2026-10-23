/**
 * 任务卡的解析、渲染与校验。纯字符串处理，不碰文件系统。
 * 格式见 docs/spec/workbench-flow.md §7.3 / §10。
 */
import { MoError } from "../errors.mjs";
import { STATES, isState } from "./model.mjs";

const KEY_ORDER = [
  "id", "project", "title", "status", "created", "updated", "from",
  "assignee", "agent", "exec", "workdir", "verify", "receipt", "timeout",
  "retries", "on_fail", "budget",
];

const SCALAR_KEYS = new Set([
  "id", "project", "title", "status", "created", "updated", "from",
  "assignee", "exec", "workdir", "receipt", "timeout", "retries", "on_fail",
]);

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "") return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+$/.test(value)) return Number(value);
  const braced = (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"));
  if (braced) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseYaml(source) {
  const lines = source
    .split(/\r?\n/)
    .map((raw) => ({ raw }))
    .filter((line) => line.raw.trim() && !line.raw.trim().startsWith("#"))
    .map((line) => ({
      indent: line.raw.match(/^\s*/)[0].length,
      text: line.raw.trim(),
    }));

  let index = 0;

  const keyLine = (text) => /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(text);

  function parseBlock(indent) {
    const out = {};
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new MoError("E_CARD_INVALID", `frontmatter 缩进不一致：${line.text}`);
      }
      const matched = keyLine(line.text);
      if (!matched) {
        throw new MoError("E_CARD_INVALID", `无法解析的 frontmatter 行：${line.text}`);
      }
      const key = matched[1];
      const rest = matched[2];
      index += 1;
      if (rest !== "") {
        out[key] = parseScalar(rest);
        continue;
      }
      const next = lines[index];
      if (next && next.indent > indent) {
        out[key] = next.text.startsWith("- ") ? parseList(next.indent) : parseBlock(next.indent);
      } else {
        out[key] = null;
      }
    }
    return out;
  }

  function parseList(indent) {
    const out = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent !== indent || !line.text.startsWith("- ")) break;
      const content = line.text.slice(2).trim();
      index += 1;
      const matched = keyLine(content);
      if (!matched) {
        out.push(parseScalar(content));
        continue;
      }
      const item = { [matched[1]]: matched[2] === "" ? null : parseScalar(matched[2]) };
      while (index < lines.length && lines[index].indent > indent) {
        const continuation = keyLine(lines[index].text);
        if (!continuation) {
          throw new MoError("E_CARD_INVALID", `列表项无法解析：${lines[index].text}`);
        }
        item[continuation[1]] = parseScalar(continuation[2]);
        index += 1;
      }
      out.push(item);
    }
    return out;
  }

  const result = parseBlock(0);
  if (index < lines.length) {
    throw new MoError("E_CARD_INVALID", `frontmatter 解析未完成：${lines[index].text}`);
  }
  return result;
}

export function parseCard(text) {
  const matched = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!matched) {
    throw new MoError("E_CARD_INVALID", "任务卡缺少 frontmatter（应以 --- 开头）");
  }
  const meta = parseYaml(matched[1]);
  const body = text.slice(matched[0].length);
  return { meta, body, raw: text };
}

function formatScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text === "" || /[:#]/.test(text) || text !== text.trim()) return JSON.stringify(text);
  return text;
}

export function renderCard({ meta, body }) {
  const known = KEY_ORDER.filter((key) => key in meta);
  const extra = Object.keys(meta).filter((key) => !KEY_ORDER.includes(key));
  const lines = ["---"];
  for (const key of [...known, ...extra]) {
    const value = meta[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        if (item && typeof item === "object") {
          const entries = Object.entries(item);
          entries.forEach(([itemKey, itemValue], position) => {
            lines.push(`${position === 0 ? "  - " : "    "}${itemKey}: ${formatScalar(itemValue)}`);
          });
        } else {
          lines.push(`  - ${formatScalar(item)}`);
        }
      }
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [itemKey, itemValue] of Object.entries(value)) {
        lines.push(`  ${itemKey}: ${formatScalar(itemValue)}`);
      }
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  lines.push("---", "");
  const tail = String(body || "").replace(/^\s*/, "");
  return lines.join("\n") + (tail ? tail + (tail.endsWith("\n") ? "" : "\n") : "");
}

export function validateCard(meta) {
  const errors = [];
  for (const key of ["id", "project", "title", "status"]) {
    if (!meta[key] || typeof meta[key] !== "string") errors.push(`缺少字段：${key}`);
  }
  if (meta.status && !isState(meta.status)) {
    errors.push(`status 非法：${meta.status}，允许值：${STATES.join(" / ")}`);
  }
  if (meta.verify !== undefined && meta.verify !== null && !Array.isArray(meta.verify)) {
    errors.push("verify 必须是列表");
  }
  if (errors.length) {
    throw new MoError("E_CARD_INVALID", errors.join("；"), { errors });
  }
  return true;
}

export function cardSections(body) {
  const sections = {};
  const pattern = /^##\s+(.+)$/gm;
  const matches = [...String(body || "").matchAll(pattern)];
  matches.forEach((matched, position) => {
    const start = matched.index + matched[0].length;
    const end = position + 1 < matches.length ? matches[position + 1].index : body.length;
    sections[matched[1].trim()] = body.slice(start, end).trim();
  });
  return sections;
}

export function verifyItems(meta) {
  const items = meta && meta.verify;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}
