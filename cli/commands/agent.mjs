import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { allTargets } from "./skill.mjs";
import { resolveProject } from "../lib/project.mjs";
import { one } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { moHome, projectDir } from "../lib/paths.mjs";
import { writeAtomic, exists, readText } from "../lib/fsx.mjs";

const BEGIN = "<!-- >>> mo >>> -->";
const END = "<!-- <<< mo <<< -->";

const STEPS = [
  "1. 补齐交付物、验收标准、边界，再 `mo task create --agent <claude|codex|qodercli|qoderclicn|pi|qwen>`",
  "2. 把卡摘要给用户，等确认",
  "3. `mo task confirm` → `mo task dispatch`",
  "4. 只按 `mo task status` / `mo ledger query` 汇报，不要替执行者宣称完成",
];

const RECEIPT_RULE = "执行者没写回执（`missing_receipt`）一律视为未完成。";

const SKILL_BLOCK = `${BEGIN}
## mo

本仓库使用 [mo](https://github.com/insky2005/mo-agent)：讨论落地时按已安装的 **mo 技能**执行
（建卡 → 回显给用户 → 等确认 → 派单），只按 \`mo task status\` / \`mo ledger query\` 的事实汇报。
${END}`;

const REF_BLOCK = `${BEGIN}
## mo

本仓库使用 [mo](https://github.com/insky2005/mo-agent)。把讨论落地时的完整用法见
\`.mo-agent/MO.md\`，开始前先读它。
${END}`;

const INLINE_BLOCK = `${BEGIN}
## mo

要把讨论落地时，用 mo CLI：

${STEPS.join("\n")}

${RECEIPT_RULE}
${END}`;

const MO_DOC = `# mo 用法

本文件由 \`mo project init\` 生成，供主 Agent 在把讨论落地时参考。

## 流程

${STEPS.join("\n")}

${RECEIPT_RULE}

## 常用命令

\`\`\`bash
mo task list                       # 本项目任务
mo task status <taskId> --json     # 状态与事件
mo ledger query --task <taskId>    # 账本流水
mo agents                          # 可用执行者模板
\`\`\`

## 铁律

- 没确认不派单（\`E_NOT_CONFIRMED\`）；
- 没拿到 taskId 不说"已派发"；
- 不手改 \`.mo-agent/tasks/*.md\`，不自己写回执；
- 一次对话最多派 3 个任务。
`;

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

/** mo agent init|remove —— 单独维护 AGENTS.md / CLAUDE.md 里的说明 */
export function agentCommand(ctx, args) {
  const sub = args.positional[0] || "init";
  if (!["init", "remove"].includes(sub)) {
    throw new MoError("E_USAGE", "未知子命令：agent " + sub + "（可用：init / remove）");
  }

  const project = resolveProject({ cwd: ctx.cwd, target: one(args.options, "project"), home: moHome() });
  const file = one(args.options, "file");

  if (sub === "remove") {
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
