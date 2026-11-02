import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readJsonSafe(file, fallback) {
  try {
    return readJson(file);
  } catch {
    return fallback;
  }
}

/** 先写临时文件再 rename，避免半截文件 */
export function writeAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

export function exists(file) {
  return fs.existsSync(file);
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line + "\n");
}

export function listFiles(dir, suffix) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !suffix || name.endsWith(suffix))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * 敏感文件：0600 落盘。tmp -> rename 保证不会留下半截，
 * chmod 在非 POSIX 上失败就忽略（Windows）。
 */
export function writeFilePrivate(file, content, mode) {
  const target = mode === undefined ? 0o600 : mode;
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content, { mode: target });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, target);
  } catch {
    // 非 POSIX 或无权限：内容已经写好了，不要因为 chmod 失败就丢
  }
}

export function writeJsonPrivate(file, value, mode) {
  writeFilePrivate(file, JSON.stringify(value, null, 2) + "\n", mode);
}

