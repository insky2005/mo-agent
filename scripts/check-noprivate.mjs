#!/usr/bin/env node
// 防止内网地址、开发机路径再次进入仓库。
//   node scripts/check-noprivate.mjs
//
// 注意：规则里的敏感词拆成两段字符串拼，避免本文件自己命中自己。
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const RULES = [
  { name: "内网私服域名", re: new RegExp("supwis" + "dom\\.com", "i") },
  { name: "内网 Harbor", re: new RegExp("harb" + "or2\\.", "i") },
  { name: "开发机路径", re: new RegExp("/Users/" + "dev\\b") },
  { name: "开发机路径", re: new RegExp("Users-" + "dev-") },
  { name: "内网网段", re: /\b172\.18\.\d{1,3}\.\d{1,3}\b/ },
];

const SKIP_DIRS = new Set([".git", "node_modules", "cli/dist", ".build", ".hutch", ".prestudy", ".cottontail-tmp"]);
const TEXT_EXT = /\.(mjs|js|cjs|ts|tsx|json|md|yml|yaml|sh|ps1|swift|java|kt|gradle|pro|xml|txt|toml|html|css)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\0").filter(Boolean);
  } catch {
    // 没有 git（slim 容器）时退回目录遍历
    const files = [];
    (function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(path.relative(ROOT, full));
      }
    })(ROOT);
    return files;
  }
}

const hits = [];
for (const rel of listFiles()) {
  if (!TEXT_EXT.test(rel)) continue;
  const full = path.join(ROOT, rel);
  let size = 0;
  try {
    size = statSync(full).size;
  } catch {
    continue;
  }
  if (size > MAX_BYTES) continue;
  const lines = readFileSync(full, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) hits.push({ rel, line: i + 1, rule: rule.name, text: line.trim().slice(0, 120) });
    }
  });
}

if (hits.length > 0) {
  console.error("发现不应提交的内容：");
  for (const h of hits) console.error(`  ${h.rel}:${h.line}  [${h.rule}]  ${h.text}`);
  console.error(`\n共 ${hits.length} 处。确认是误报就改写该行或加白名单。`);
  process.exit(1);
}

console.log("✓ 未发现内网地址 / 开发机路径");
