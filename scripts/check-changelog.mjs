#!/usr/bin/env node
// 校验 CHANGELOG.md：
//   默认（开发期）：必须有 ## [Unreleased] 段；
//   --release（发版时）：还必须有当前 package.json 版本的小节。
//
//   node scripts/check-changelog.mjs
//   node scripts/check-changelog.mjs --release
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const release = process.argv.includes("--release");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const file = path.join(ROOT, "CHANGELOG.md");

if (!fs.existsSync(file)) {
  console.error("[changelog] 缺少 CHANGELOG.md");
  process.exit(1);
}

const text = fs.readFileSync(file, "utf8");
const problems = [];

if (!/^## \[Unreleased\]/m.test(text)) problems.push("缺少 ## [Unreleased] 段");

const version = pkg.version;
if (release) {
  const section = new RegExp("^## \\[" + version.replace(/\./g, "\\.") + "\\]", "m");
  if (!section.test(text)) {
    problems.push("缺少当前版本小节：## [" + version + "] - YYYY-MM-DD");
  }
}

if (problems.length) {
  console.error("[changelog] " + problems.join("；"));
  if (release) console.error("  发版前把 Unreleased 的内容挪到 ## [" + version + "] 下，并写上日期。");
  process.exit(1);
}

console.log(release ? "[changelog] 发版检查通过：" + version : "[changelog] 有 Unreleased 段");
