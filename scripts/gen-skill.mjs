#!/usr/bin/env node
/**
 * 生成技能产物，两件：
 *  1. skills/mo/SKILL.md      ← 由 core/manager/contract.mjs 渲染（唯一真源）
 *  2. cli/lib/skill-content.mjs ← 把 SKILL.md 内联进代码（单文件二进制里没有 skills/ 目录）
 *
 * 两处都是生成物，npm run check 会校验是否最新，不要手改。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSkill } from "../core/manager/contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillFile = path.join(root, "skills", "mo", "SKILL.md");
const inlineFile = path.join(root, "cli", "lib", "skill-content.mjs");

const markdown = renderSkill();
const generated =
  "// 由 scripts/gen-skill.mjs 从 core/manager/contract.mjs 生成，勿手改。\n" +
  "export const SKILL_NAME = \"mo\";\n" +
  "export const SKILL_MD = " + JSON.stringify(markdown) + ";\n";

if (process.argv.includes("--check")) {
  const problems = [];
  for (const [file, expected] of [[skillFile, markdown], [inlineFile, generated]]) {
    let current = "";
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      current = "";
    }
    if (current !== expected) problems.push(path.relative(root, file));
  }
  if (problems.length) {
    console.error("[skill] 已过期：" + problems.join(", ") + "，运行：npm run gen:skill");
    process.exit(1);
  }
  console.log("[skill] 技能文案已是最新");
} else {
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, markdown);
  fs.mkdirSync(path.dirname(inlineFile), { recursive: true });
  fs.writeFileSync(inlineFile, generated);
  console.log("[skill] 已写入 " + path.relative(root, skillFile) + " 与 " + path.relative(root, inlineFile));
}
