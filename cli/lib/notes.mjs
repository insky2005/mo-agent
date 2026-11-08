import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { ensureDir } from "./fsx.mjs";
import { appendEvent } from "./store.mjs";

/**
 * 过程文档（note_write）：Router 唯一能自己"写"的东西。
 *
 * 约束来自 docs/spec/router.md §5.4：
 *  - 落点固定 ~/.mo-agent/notes/YYYY-MM-DD-<slug>.md，**不接受路径参数**；
 *  - slug 只允许 [a-z0-9-]，≤64 字符，缺省由 title 生成；
 *  - 同日同 slug 不覆盖，自动加 -2、-3…（append-only）；
 *  - 单篇上限 64KB，超了报 E_NOTE_TOO_LARGE，由 Router 自己拆；
 *  - 不提供编辑 / 删除；要改就再写一版；
 *  - 每次落盘记账本 note.written（path / bytes / title / owner）。
 */

export const NOTE_MAX_BYTES = 64 * 1024;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export function notesDir(home) {
  return path.join(home, "notes");
}

/** 标题里的中文留不下来（slug 只能 ASCII），退化成 note，避免生成一串横线。 */
export function slugFromTitle(title) {
  const ascii = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return ascii || "note";
}

function dayStamp(now) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export function writeNote(options = {}) {
  const home = options.home;
  const title = String(options.title || "").trim();
  if (!title) throw new MoError("E_USAGE", "note_write 需要 title");

  const body = String(options.body == null ? "" : options.body);
  if (!body.trim()) throw new MoError("E_USAGE", "note_write 需要 body");

  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > NOTE_MAX_BYTES) {
    throw new MoError("E_NOTE_TOO_LARGE", "单篇笔记不能超过 64KB（当前 " + bytes + " 字节）", {
      hint: "拆成几篇分别写，或把交付物交给 Worker",
    });
  }

  const slug = String(options.slug || slugFromTitle(title));
  if (!SLUG_RE.test(slug)) {
    throw new MoError("E_USAGE", "slug 只能是小写字母、数字与连字符，且不超过 64 字符：" + slug);
  }

  const tags = (Array.isArray(options.tags) ? options.tags : [])
    .map((tag) => String(tag).trim())
    .filter(Boolean);

  const now = options.now instanceof Date ? options.now : new Date();
  const owner = options.owner || "router";
  const dir = notesDir(home);
  ensureDir(dir);

  const base = dayStamp(now) + "-" + slug;
  let file = path.join(dir, base + ".md");
  for (let index = 2; fs.existsSync(file) && index <= 99; index += 1) {
    file = path.join(dir, base + "-" + index + ".md");
  }
  if (fs.existsSync(file)) {
    throw new MoError("E_NOTE_CONFLICT", "同一天同名笔记太多了：" + base);
  }

  const content = [
    "---",
    "title: " + JSON.stringify(title),
    "slug: " + slug,
    "date: " + now.toISOString(),
    "tags: [" + tags.join(", ") + "]",
    "owner: " + owner,
    "---",
    "",
    body.trimEnd(),
    "",
  ].join("\n");

  fs.writeFileSync(file, content, { mode: 0o644 });
  appendEvent(home, {
    type: "note.written",
    actor: "agent",
    payload: { path: path.relative(home, file), bytes, title, owner, tags },
  });

  return {
    ok: true,
    path: file,
    id: path.basename(file, ".md"),
    bytes,
    title,
    owner,
    tags,
  };
}
