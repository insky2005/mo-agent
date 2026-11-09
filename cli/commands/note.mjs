import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { all, one } from "../ui/args.mjs";
import { emit } from "../ui/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { writeNote } from "../lib/notes.mjs";

/**
 * mo internal note-write —— note_write 的 CLI 说法（MCP 只是薄壳）。
 * 只接受 JSON（--file - 或直接给字段），不接受任何路径参数。
 */
export function noteCommand(ctx, args) {
  const sub = args.positional[0];
  if (sub !== "write") {
    throw new MoError("E_USAGE", "未知子命令：note " + (sub || "") + "（可用：write）");
  }

  let input = {};
  if (one(args.options, "file") === "-") {
    const raw = fs.readFileSync(0, "utf8");
    try {
      input = JSON.parse(raw);
    } catch {
      throw new MoError("E_USAGE", "stdin 不是合法 JSON");
    }
  }

  const note = writeNote({
    home: moHome(),
    title: one(args.options, "title") || input.title,
    body: one(args.options, "body") || input.body,
    slug: one(args.options, "slug") || input.slug,
    tags: all(args.options, "tag").length ? all(args.options, "tag") : input.tags,
  });

  emit(args.options, note, () => "✓ 已记录笔记\n\n  " + note.path + "\n  " + note.bytes + " 字节");
  return 0;
}
