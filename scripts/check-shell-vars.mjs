#!/usr/bin/env node
/**
 * 拦截一类真实踩过的坑：$var 后面紧跟非 ASCII 字符（中文、全角括号等）。
 *
 * Bash 把这类字符也算作变量名的一部分，于是 $rc（ 会去找变量 rc（；
 * 开了 set -u 就报 "rc�: unbound variable"，而且报错信息里的字节是乱的，很难认。
 *
 * 正确写法：${rc}（
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["scripts", "."];
const pattern = /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/g;

let problems = 0;
for (const dir of dirs) {
  const base = path.join(root, dir);
  for (const name of fs.readdirSync(base)) {
    if (!name.endsWith(".sh")) continue;
    const file = path.join(base, name);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith("#")) return;
      let matched;
      pattern.lastIndex = 0;
      while ((matched = pattern.exec(line))) {
        problems += 1;
        console.error(
          path.relative(root, file) + ":" + (index + 1) + "  " + matched[0] +
          " 后紧跟非 ASCII 字符，请改成 ${" + matched[0].slice(1) + "}",
        );
      }
    });
  }
}

if (problems) {
  console.error("[shell-vars] 发现 " + problems + " 处需要加花括号");
  process.exit(1);
}
console.log("[shell-vars] 变量边界检查通过");
