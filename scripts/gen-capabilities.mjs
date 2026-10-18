#!/usr/bin/env node
/**
 * 从 adapters/profiles/*.json 生成 Agent 能力表。
 *   node scripts/gen-capabilities.mjs          # 写入 docs/capabilities.md
 *   node scripts/gen-capabilities.mjs --check  # 只校验是否最新
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles } from "../adapters/registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const profilesDir = path.join(root, "adapters", "profiles");
const target = path.join(root, "docs", "capabilities.md");

function code(value) {
  return value ? "`" + String(value) + "`" : "—";
}

function list(value) {
  if (!Array.isArray(value) || !value.length) return "—";
  return value.map(code).join(", ");
}

const profiles = loadProfiles(profilesDir)
  .filter((profile) => profile.enabled !== false)
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

const rows = profiles.map((profile) => {
  const caps = profile.capabilities || {};
  return [
    code(profile.id),
    profile.label || "—",
    list(caps.observe),
    code(caps.runEnd || "none"),
    code(caps.attention || "none"),
    code(caps.approval || "none"),
    list(caps.control),
    code(profile.session && profile.session.kind),
    code(profile.module || ""),
  ].join(" | ");
});

const markdown = [
  "# Agent 能力表",
  "",
  "由 `scripts/gen-capabilities.mjs` 从 `adapters/profiles/*.json` 生成，勿手改。",
  "",
  "| Agent | 名称 | 观测 | runEnd | 注意 | 批准 | 控制 | 数据源 | 模块 |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((row) => "| " + row + " |"),
  "",
].join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = fs.readFileSync(target, "utf8");
  } catch (error) {
    current = "";
  }
  if (current !== markdown) {
    console.error("[capabilities] docs/capabilities.md 已过期，运行：npm run docs:capabilities");
    process.exit(1);
  }
  console.log("[capabilities] 文档已是最新");
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown);
  console.log("[capabilities] 已写入 " + path.relative(root, target));
}
