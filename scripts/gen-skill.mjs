#!/usr/bin/env node
/**
 * 把 skills/mo/SKILL.md 内联成 cli/lib/skill-content.mjs。
 *
 * 为什么内联：单文件二进制里没有 skills/ 目录，`mo skill install` 只能靠代码里的副本。
 * 源文件仍是 SKILL.md；这个生成物由 npm run check 校验，不要手改。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "skills", "mo", "SKILL.md");
const target = path.join(root, "cli", "lib", "skill-content.mjs");

const markdown = fs.readFileSync(source, "utf8");
const generated =
  "// 由 scripts/gen-skill.mjs 从 skills/mo/SKILL.md 生成，勿手改。\n" +
  "export const SKILL_NAME = \"mo\";\n" +
  "export const SKILL_MD = " + JSON.stringify(markdown) + ";\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    current = "";
  }
  if (current !== generated) {
    console.error("[skill] cli/lib/skill-content.mjs 已过期，运行：npm run gen:skill");
    process.exit(1);
  }
  console.log("[skill] 内联内容已是最新");
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, generated);
  console.log("[skill] 已写入 " + path.relative(root, target));
}
