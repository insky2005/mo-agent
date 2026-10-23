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
