import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Pi 控制扩展的安装/卸载。
 *
 * Pi 没有外部 hook 配置，用户自己开的 Pi 只能靠 ~/.pi/agent/extensions/ 下的进程内模块。
 * 这里只负责把 integrations/pi 下的两个文件原子写进去，并在覆盖前备份。
 */
export const PI_EXTENSION_FILES = ["mo-agent-control.js", "mo-agent-control-impl.js"];
export const PI_EXTENSION_MARKER = "MO_AGENT_PI_CONTROL";

export function piAgentDir(options) {
  const opts = options || {};
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const override = env.PI_CODING_AGENT_DIR;
  if (override) {
    const raw = String(override);
    return path.resolve(raw.startsWith("~") ? path.join(home, raw.slice(1)) : raw);
  }
  return path.join(home, ".pi", "agent");
}

export function piExtensionDir(options) {
  return path.join(piAgentDir(options), "extensions");
}

export function piExtensionSourceDir(root) {
  return path.join(root, "integrations", "pi");
}

function readSource(root, name) {
  return fs.readFileSync(path.join(piExtensionSourceDir(root), name), "utf8");
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function backupName(file, now) {
  const stamp = new Date(now || Date.now()).toISOString().replace(/[:.]/g, "-");
  return file + ".mo-agent.bak-" + stamp;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    return null;
  }
}

export function piExtensionStatus(options) {
  const opts = options || {};
  const root = opts.root;
  const dir = piExtensionDir(opts);
  const files = PI_EXTENSION_FILES.map((name) => {
    const target = path.join(dir, name);
    let source = null;
    try {
      source = readSource(root, name);
    } catch (error) {
      source = null;
    }
    const current = readIfExists(target);
    return {
      name,
      target,
      exists: current !== null,
      current: current !== null,
      marker: current !== null && current.includes(PI_EXTENSION_MARKER),
      outdated: source !== null && current !== null && current !== source,
      missingSource: source === null,
    };
  });
  const installed = files.every((file) => file.exists && file.marker);
  const outdated = installed && files.some((file) => file.outdated);
  return { dir, files, installed, outdated };
}

export function installPiExtension(options) {
  const opts = options || {};
  const root = opts.root;
  const dir = piExtensionDir(opts);
  const result = { ok: true, dir, changed: false, files: [], backups: [] };

  for (const name of PI_EXTENSION_FILES) {
    let source;
    try {
      source = readSource(root, name);
    } catch (error) {
      return { ok: false, dir, changed: false, error: "找不到扩展源文件: " + name, files: [], backups: [] };
    }
    const target = path.join(dir, name);
    const current = readIfExists(target);
    if (current === source) {
      result.files.push({ name, target, action: "unchanged" });
      continue;
    }
    result.changed = true;
    let backup = null;
    if (current !== null) {
      backup = backupName(target, opts.now);
      if (!opts.dryRun) {
        result.backups.push(backup);
        fs.renameSync(target, backup);
      }
    }
    const item = { name, target, action: current === null ? "created" : "updated" };
    if (backup) item.backup = backup;
    result.files.push(item);
    if (!opts.dryRun) atomicWrite(target, source);
  }

  return result;
}

export function uninstallPiExtension(options) {
  const opts = options || {};
  const dir = piExtensionDir(opts);
  const result = { ok: true, dir, changed: false, files: [] };

  for (const name of PI_EXTENSION_FILES) {
    const target = path.join(dir, name);
    const current = readIfExists(target);
    if (current === null) {
      result.files.push({ name, target, action: "missing" });
      continue;
    }
    if (!current.includes(PI_EXTENSION_MARKER)) {
      result.files.push({ name, target, action: "kept", reason: "不是 mo-agent 安装的文件" });
      continue;
    }
    result.changed = true;
    result.files.push({ name, target, action: "removed" });
    if (!opts.dryRun) fs.unlinkSync(target);
  }

  return result;
}
