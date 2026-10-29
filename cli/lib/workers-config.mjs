/**
 * 自定义 worker（执行者模板）的注册表。
 *
 * 三个来源，后者覆盖前者：
 *   内置（cli/lib/executors.mjs） < 个人（~/.mo-agent/workers.json） < 项目（<repo>/.mo-agent/workers.json）
 */
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { EXECUTORS, commandFor, workerStatus } from "./executors.mjs";
import { readJsonSafe, writeJsonAtomic, exists } from "./fsx.mjs";
import { projectDir } from "./paths.mjs";

export const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function userWorkersFile(home) {
  return path.join(home, "workers.json");
}

export function projectWorkersFile(root) {
  return path.join(projectDir(root), "workers.json");
}

function readConfig(file) {
  const data = readJsonSafe(file, null);
  if (!data || typeof data !== "object") return { workers: {}, default: "" };
  const workers = data.workers && typeof data.workers === "object" ? data.workers : {};
  const fallback = typeof data.default === "string" ? data.default : "";
  return { workers, default: fallback };
}

function writeConfig(file, config) {
  writeJsonAtomic(file, {
    version: 1,
    workers: config.workers,
    ...(config.default ? { default: config.default } : {}),
  });
}

export function loadConfigs({ home, projectRoot } = {}) {
  return {
    user: home ? readConfig(userWorkersFile(home)) : { workers: {}, default: "" },
    project: projectRoot ? readConfig(projectWorkersFile(projectRoot)) : { workers: {}, default: "" },
  };
}

/** 项目默认优先于个人默认 */
export function defaultWorkerName({ home, projectRoot } = {}) {
  const config = loadConfigs({ home, projectRoot });
  return config.project.default || config.user.default || "";
}

export function listWorkers({ home, projectRoot } = {}) {
  const { user, project } = loadConfigs({ home, projectRoot });
  const fallback = project.default || user.default || "";
  const merged = new Map();

  for (const [name, preset] of Object.entries(EXECUTORS)) {
    const command = commandFor(preset);
    merged.set(name, { name, ...preset, command, supported: command !== null, source: "builtin" });
  }
  for (const [name, entry] of Object.entries(user.workers)) {
    merged.set(name, { name, ...entry, source: "user" });
  }
  for (const [name, entry] of Object.entries(project.workers)) {
    merged.set(name, { name, ...entry, source: "project" });
  }

  return [...merged.values()].map((worker) => ({
    ...worker,
    ...workerStatus(worker),
    default: worker.name === fallback,
  }));
}

/** `assignee: auto` 时用的 worker；没设默认就返回 null */
export function resolveDefaultWorker({ home, projectRoot } = {}) {
  const name = defaultWorkerName({ home, projectRoot });
  if (!name) return null;
  const found = listWorkers({ home, projectRoot }).find((worker) => worker.name === name);
  if (!found || found.supported === false) return null;
  return found;
}

export function setDefaultWorker({ home, projectRoot, project = false, name, clear = false }) {
  if (clear) {
    const file = project ? projectWorkersFile(projectRoot) : userWorkersFile(home);
    const config = readConfig(file);
    config.default = "";
    writeConfig(file, config);
    return { name: "", file, cleared: true };
  }

  const key = String(name || "").trim();
  const found = listWorkers({ home, projectRoot }).find((worker) => worker.name === key);
  if (!found) {
    throw new MoError("E_NOT_FOUND", "没有这个 worker：" + key, { hint: "mo worker list 查看可用 worker" });
  }
  if (found.supported === false) {
    throw new MoError("E_UNSUPPORTED_PLATFORM", "worker " + key + " 不支持当前平台", {
      hint: "mo worker list 查看当前平台可用的 worker",
    });
  }

  const file = project ? projectWorkersFile(projectRoot) : userWorkersFile(home);
  const config = readConfig(file);
  config.default = key;
  writeConfig(file, config);
  return { name: key, file, session: Boolean(found.session), installed: found.installed };
}

export function resolveWorker(name, ctx = {}) {
  const workers = listWorkers(ctx);
  const found = workers.find((worker) => worker.name === String(name).trim());
  if (!found) {
    throw new MoError("E_USAGE", "未知执行者：" + name, {
      hint: "可用：mo worker list",
    });
  }
  if (found.supported === false) {
    throw new MoError("E_UNSUPPORTED_PLATFORM", "执行者 " + name + " 不支持当前平台", {
      hint: "mo worker list 查看当前平台可用的执行者，或改用 --exec",
    });
  }
  return found;
}

export function addWorker({ name, command, description = "", requires = "", project = false, session = false, use = false, home, projectRoot }) {
  const key = String(name || "").trim();
  if (!NAME_RE.test(key)) {
    throw new MoError("E_USAGE", "名称不合法：" + key, {
      hint: "小写字母、数字、连字符，例如 my-claude",
    });
  }
  if (!command || typeof command !== "string" || !command.trim()) {
    throw new MoError("E_USAGE", "缺少 --command");
  }
  if (EXECUTORS[key]) {
    throw new MoError("E_USAGE", key + " 与内置执行者同名，换一个名称");
  }
  if (project && !projectRoot) {
    throw new MoError("E_PROJECT_UNBOUND", "使用 --project 时需要项目上下文");
  }

  const file = project ? projectWorkersFile(projectRoot) : userWorkersFile(home);
  const config = readConfig(file);
  config.workers[key] = {
    command: command.trim(),
    description: String(description || "").trim(),
    ...(requires ? { requires: String(requires).trim() } : {}),
    ...(session ? { session: true } : {}),
  };
  if (use) config.default = key;
  writeConfig(file, config);
  return { name: key, file, ...config.workers[key], default: config.default === key };
}

export function removeWorker({ name, project = false, home, projectRoot }) {
  const key = String(name || "").trim();
  if (EXECUTORS[key]) {
    throw new MoError("E_USAGE", key + " 是内置执行者，不能删除");
  }

  const primary = project ? projectWorkersFile(projectRoot) : userWorkersFile(home);
  const secondary = project ? userWorkersFile(home) : projectRoot ? projectWorkersFile(projectRoot) : null;
  const primaryConfig = readConfig(primary);

  if (primaryConfig.workers[key]) {
    delete primaryConfig.workers[key];
    if (primaryConfig.default === key) primaryConfig.default = "";
    writeConfig(primary, primaryConfig);
    return { name: key, file: primary, clearedDefault: primaryConfig.default === "" };
  }

  if (secondary && exists(secondary) && readConfig(secondary).workers[key]) {
    throw new MoError("E_NOT_FOUND", key + " 不在当前范围", {
      hint: "它定义在另一个作用域，加上 " + (project ? "去掉 --project" : "--project") + " 再试",
    });
  }

  throw new MoError("E_NOT_FOUND", "没有这个 worker：" + key);
}