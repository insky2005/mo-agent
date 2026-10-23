import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { allTargets } from "./skill.mjs";
import { resolveProject } from "../lib/project.mjs";
import { one, all } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { writeAtomic, exists, readText } from "../lib/fsx.mjs";

const BEGIN = "<!-- >>> mo >>> -->";
const END = "<!-- <<< mo <<< -->";

const SKILL_BLOCK = `${BEGIN}
## mo

mo 技能已安装。把讨论落地时按该技能走：建卡 → 回显给用户 → 等确认 → 派单；
只按 \`mo task status\` / \`mo ledger query\` 的事实汇报，不要替执行者宣称完成。
${END}`;

const INLINE_BLOCK = `${BEGIN}
## mo

要把讨论落地时，用 mo CLI：

1. 补齐交付物、验收标准、边界，再 \`mo task create --agent <claude|codex|qodercli|qoderclicn|pi|qwen>\`
2. 把卡摘要给用户，等确认
3. \`mo task confirm\` → \`mo task dispatch\`
4. 只按 \`mo task status\` / \`mo ledger query\` 汇报，不要替执行者宣称完成

执行者没写回执（\`missing_receipt\`）一律视为未完成。
${END}`;

function skillInstalled() {
  return allTargets().some((target) => target.installed);
}

function stripBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) return text;
  return (text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}/g, "\n\n");
}

function pickFile(root, explicit) {
  if (explicit && explicit !== true) return path.resolve(root, String(explicit));
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const candidate = path.join(root, name);
    if (exists(candidate)) return candidate;
  }
  return path.join(root, "AGENTS.md");
}

/** mo agent init|remove —— 在 AGENTS.md / CLAUDE.md 里维护一段可复位的说明 */
export function agentCommand(ctx, args) {
  const sub = args.positional[0] || "init";
  if (!["init", "remove"].includes(sub)) {
    throw new MoError("E_USAGE", "未知子命令：agent " + sub + "（可用：init / remove）");
  }

  const project = resolveProject({ cwd: ctx.cwd, target: one(args.options, "project"), home: moHome() });
  const file = pickFile(project.root, one(args.options, "file"));
  const current = exists(file) ? readText(file) : "";

  if (sub === "remove") {
    if (!current.includes(BEGIN)) {
      emit(args.options, { ok: true, changed: false }, "没有需要移除的段落");
      return 0;
    }
    writeAtomic(file, stripBlock(current).replace(/\n+$/, "\n"));
    emit(args.options, { ok: true, changed: true, file }, "✓ 已移除 " + path.relative(project.root, file));
    return 0;
  }

  const requested = one(args.options, "mode", "auto");
  const mode = requested === "auto" ? (skillInstalled() ? "skill" : "inline") : requested;
  if (!["skill", "inline"].includes(mode)) {
    throw new MoError("E_USAGE", "未知 mode：" + requested + "（可用：auto / skill / inline）");
  }

  const block = mode === "skill" ? SKILL_BLOCK : INLINE_BLOCK;
  const base = stripBlock(current).replace(/\n+$/, "");
  const next = (base ? base + "\n\n" : "") + block + "\n";
  writeAtomic(file, next);

  emit(args.options, { ok: true, file, mode }, () =>
    "✓ " + path.relative(project.root, file) + "（" + (mode === "skill" ? "技能已装，写指针" : "内联用法") + "）");
  return 0;
}
