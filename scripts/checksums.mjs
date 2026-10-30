#!/usr/bin/env node
// 给发布目录里的产物生成 SHA256：每个文件一份 .sha256，外加合并的 SHA256SUMS。
// install-remote.sh 只认 <asset>.sha256，SHA256SUMS 给人看 / 给别的渠道用。
//
//   node scripts/checksums.mjs dist
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] || "dist");
const SKIP = /(\.sha256$|^SHA256SUMS$)/;

const files = fs
  .readdirSync(dir)
  .filter((name) => fs.statSync(path.join(dir, name)).isFile())
  .filter((name) => !SKIP.test(name))
  .sort();

if (files.length === 0) {
  console.error("没有可计算的文件：" + dir);
  process.exit(1);
}

const lines = [];
for (const name of files) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
  fs.writeFileSync(path.join(dir, name + ".sha256"), `${hash}  ${name}\n`);
  lines.push(`${hash}  ${name}`);
}

fs.writeFileSync(path.join(dir, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
