import fs from "node:fs";
import path from "node:path";

/** Router 用的小工具：读 JSON 不抛、原子写、敏感文件 0600。 */

export function readJsonSafe(file, fallback) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** tmp -> fsync 语义靠 rename，最后 chmod 0600；非 POSIX 平台忽略 chmod 失败 */
export function writeFilePrivate(file, content, mode) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content, { mode: mode === undefined ? 0o600 : mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode === undefined ? 0o600 : mode);
  } catch {
    // 非 POSIX 或无权限：忽略，不因为 chmod 失败就丢了已经写好的内容
  }
}

export function writeJsonPrivate(file, value, mode) {
  writeFilePrivate(file, JSON.stringify(value, null, 2) + "\n", mode);
}
