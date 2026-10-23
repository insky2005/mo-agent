#!/usr/bin/env node
/** 校验 cli/lib/version.mjs 与 package.json 的版本一致（单文件二进制靠它）。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "cli", "lib", "version.mjs"), "utf8");
const matched = /VERSION = "([^"]+)"/.exec(source);

if (!matched || matched[1] !== pkg.version) {
  console.error(
    "[version] 版本不一致：package.json=" + pkg.version +
    "，cli/lib/version.mjs=" + (matched ? matched[1] : "未找到"),
  );
  process.exit(1);
}
console.log("[version] 一致：" + pkg.version);
