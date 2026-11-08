import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 自我定位：要 spawn 一个"自己"的时候用。
 *
 * 源码运行：node + cli/mo.mjs；
 * 单文件二进制：import.meta.url 不是真实路径，直接 execPath 就是 mo 本身。
 */
export function selfCommand() {
  try {
    const entry = fileURLToPath(new URL("../mo.mjs", import.meta.url));
    if (fs.existsSync(entry)) return { command: process.execPath, prefix: [entry] };
  } catch {
    // 单文件二进制里 import.meta.url 不是真实路径，落到下面的分支
  }
  return { command: process.execPath, prefix: [] };
}
