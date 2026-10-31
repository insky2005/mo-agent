#!/usr/bin/env node
// 改版本号：package.json / cli/lib/version.mjs / package-lock.json 一次改齐。
//
//   node scripts/bump-version.mjs 0.2.1
//
// 只改版本号，不动 CHANGELOG、不提交、不打 tag。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SEMVER = /^\d+\.\d+\.\d+$/;

export function updatePackageJson(text, version) {
  const pkg = JSON.parse(text);
  pkg.version = version;
  return JSON.stringify(pkg, null, 2) + "\n";
}

export function updateLock(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  return JSON.stringify(lock, null, 2) + "\n";
}

export function updateVersionModule(text, version) {
  if (!/export const VERSION = "[^"]*";/.test(text)) throw new Error("cli/lib/version.mjs 里找不到 VERSION");
  return text.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`);
}

function main(argv) {
  const version = String(argv[0] || "").trim();
  if (!SEMVER.test(version)) {
    console.error("用法：node scripts/bump-version.mjs <x.y.z>");
    console.error("  版本号必须形如 0.2.1，不带 v 前缀");
    process.exit(1);
  }

  const files = {
    "package.json": updatePackageJson,
    "package-lock.json": updateLock,
    "cli/lib/version.mjs": updateVersionModule,
  };

  for (const [rel, fn] of Object.entries(files)) {
    const file = path.join(ROOT, rel);
    const next = fn(fs.readFileSync(file, "utf8"), version);
    fs.writeFileSync(file, next);
  }

  console.log("[bump] 版本号改为 " + version);
  console.log("  改了：package.json / package-lock.json / cli/lib/version.mjs");
  console.log("  下一步：node scripts/check-version.mjs");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main(process.argv.slice(2));
