#!/usr/bin/env node
// lockfile 里的 tarball 地址必须是公共源，否则 CI 会去拉内网/私有镜像。
// 本地用镜像（npmmirror 等）没问题：npm 会按 replace-registry-host 自动换源，
// 但别把镜像地址写进 package-lock.json 一起提交。
//
//   node scripts/check-lockfile-registry.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOW = new Set(["registry.npmjs.org"]);

const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

const hosts = new Map();
for (const [name, meta] of Object.entries(lock.packages || {})) {
  const url = meta && meta.resolved;
  if (!url || !/^https?:\/\//.test(url)) continue;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    continue;
  }
  if (!hosts.has(host)) hosts.set(host, []);
  hosts.get(host).push(name || "(root)");
}

const bad = [...hosts.entries()].filter(([host]) => !ALLOW.has(host));
if (bad.length > 0) {
  console.error("package-lock.json 里有非公共源的 tarball 地址：");
  for (const [host, names] of bad) {
    console.error(`  ${host}  →  ${names.length} 个包，例如 ${names.slice(0, 3).join(", ")}`);
  }
  console.error("\n修法：npm install --registry=https://registry.npmjs.org");
  process.exit(1);
}

console.log(`✓ lockfile 来源全部是 registry.npmjs.org（${Object.keys(lock.packages || {}).length} 个条目）`);
