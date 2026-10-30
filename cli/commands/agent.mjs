import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { allTargets } from "./skill.mjs";
import { resolveRoot } from "../lib/project.mjs";
import { has, one } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { moHome, projectDir } from "../lib/paths.mjs";
import { writeAtomic, exists, readText } from "../lib/fsx.mjs";
import { renderAgentBlock, renderMoDoc, renderPointer } from "../../core/manager/contract.mjs";

const BEGIN = "<!-- >>> mo >>> -->";
const END = "<!-- <<< mo <<< -->";

/** 文案全部来自 core/manager/contract.mjs，这里只负责包边界与落盘 */
const SKILL_BLOCK = BEGIN + "\n" + renderPointer("把讨论落地时按已安装的 **mo 技能**执行（建卡 → 回显 → 等批准 → 派单）") + "\n" + END;
const REF_BLOCK = BEGIN + "\n" + renderPointer("把讨论落地时的完整用法见 `.mo-agent/MO.md`，开始前先读它") + "\n" + END;
const INLINE_BLOCK = BEGIN + "\n" + renderAgentBlock() + "\n" + END;
const MO_DOC = renderMoDoc();

export function skillInstalled() {
  return allTargets().some((target) => target.installed);
}

function stripBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) return text;
  return (text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}/g, "\n\n");
}

export function pickAgentFile(root, explicit) {
  if (explicit && explicit !== true) return path.resolve(root, String(explicit));
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const candidate = path.join(root, name);
    if (exists(candidate)) return candidate;
  }
  return path.join(root, "AGENTS.md");
}

/**
 * 写入/更新 Agent 说明文件。
 * mode: auto（有技能→指针，无技能→MO.md+引用）| skill | ref | inline
 */
export function applyAgentFile({ root, file, mode = "auto" }) {
  const target = pickAgentFile(root, file);
  const installed = skillInstalled();
  const actual = mode === "auto" ? (installed ? "skill" : "ref") : mode;
  if (!["skill", "ref", "inline"].includes(actual)) {
    throw new MoError("E_USAGE", "未知 mode：" + mode + "（可用：auto / skill / ref / inline）");
  }

  if (actual === "ref") {
    writeAtomic(path.join(projectDir(root), "MO.md"), MO_DOC);
  }

  const block = actual === "skill" ? SKILL_BLOCK : actual === "ref" ? REF_BLOCK : INLINE_BLOCK;
  const current = exists(target) ? readText(target) : "";
  const base = stripBlock(current).replace(/\n+$/, "");
  writeAtomic(target, (base ? base + "\n\n" : "") + block + "\n");
  return { file: target, mode: actual };
}

export function removeAgentFile({ root, file }) {
  const target = pickAgentFile(root, file);
  if (!exists(target)) return { file: target, changed: false };
  const current = readText(target);
  if (!current.includes(BEGIN)) return { file: target, changed: false };
  writeAtomic(target, stripBlock(current).replace(/\n+$/, "\n"));
  return { file: target, changed: true };
}

/** mo project agent [--remove] —— 维护 AGENTS.md / CLAUDE.md 里的说明 */
export function projectAgent(ctx, args) {
  const project = resolveRoot({ cwd: ctx.cwd, target: one(args.options, "project"), home: moHome() });
  const file = one(args.options, "file");

  if (has(args.options, "remove")) {
    const result = removeAgentFile({ root: project.root, file });
    emit(args.options, { ok: true, ...result }, () =>
      result.changed ? "✓ 已移除 " + path.relative(project.root, result.file) : "没有需要移除的段落");
    return 0;
  }

  const result = applyAgentFile({ root: project.root, file, mode: one(args.options, "mode", "auto") });
  emit(args.options, { ok: true, ...result }, () =>
    "✓ " + path.relative(project.root, result.file) + "（" + {
      skill: "技能已装，写指针",
      ref: "写 MO.md + 引用",
      inline: "内联用法",
    }[result.mode] + "）");
  return 0;
}