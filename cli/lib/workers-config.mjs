/**
 * 自定义 worker（执行者模板）的注册表。
 *
 * 三个来源，后者覆盖前者：
 *   内置（cli/lib/executors.mjs） < 个人（~/.mo-agent/workers.json） < 项目（<repo>/.mo-agent/workers.json）
 */
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { EXECUTORS, workerStatus } from "./executors.mjs";
import { readJsonSafe, writeJsonAtomic, exists } from "./fsx.mjs";
import { projectDir } from "./paths.mjs";

export const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function userWorkersFile(home) {
  return path.join(home, "workers.json");
}

export function projectWorkersFile(root) {
  return path.join(projectDir(root), "workers.json");
}

function readWorkers(file) {
  const data = readJsonSafe(file, null);
  if (!data || typeof data !== "object" || !data.workers || typeof data.workers !== "object") {
    return {};
  }
  return data.workers;
}

function writeWorkers(file, workers) {
  writeJsonAtomic(file, { version: 1, workers });
}

export function loadConfigs({ home, projectRoot } = {}) {
  return {
    user: home ? readWorkers(userWorkersFile(home)) : {},
    project: projectRoot ? readWorkers(projectWorkersFile(projectRoot)) : {},
  };
}

export function listWorkers({ home, projectRoot } = {}) {
  const { user, project } = loadConfigs({ home, projectRoot });
  const merged = new Map();

  for (const [name, preset] of Object.entries(EXECUTORS)) {
    merged.set(name, { name, ...preset, source: "builtin" });
  }
  for (const [name, entry] of Object.entries(user)) {
    merged.set(name, { name, ...entry, source: "user" });
  }
  for (const [name, entry] of Object.entries(project)) {
    merged.set(name, { name, ...entry, source: "project" });
  }

  return [...merged.values()].map((worker) => ({
    ...worker,
    ...workerStatus(worker),
  }));
}

export function resolveWorker(name, ctx = {}) {
  const workers = listWorkers(ctx);
  const found = workers.find((worker) => worker.name === String(name).trim());
  if (!found) {
    throw new MoError("E_USAGE", "未知执行者：" + name, {
      hint: "可用：mo worker list",
    });
  }
  return found;
}

export function addWorker({ name, command, description = "", requires = "", project = false, session = false, home, projectRoot }) {
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
  const workers = readWorkers(file);
  workers[key] = {
    command: command.trim(),
    description: String(description || "").trim(),
    ...(requires ? { requires: String(requires).trim() } : {}),
    ...(session ? { session: true } : {}),
  };
  writeWorkers(file, workers);
  return { name: key, file, ...workers[key] };
}

export function removeWorker({ name, project = false, home, projectRoot }) {
  const key = String(name || "").trim();
  if (EXECUTORS[key]) {
    throw new MoError("E_USAGE", key + " 是内置执行者，不能删除");
  }

  const primary = project ? projectWorkersFile(projectRoot) : userWorkersFile(home);
  const secondary = project ? userWorkersFile(home) : projectRoot ? projectWorkersFile(projectRoot) : null;
  const primaryWorkers = readWorkers(primary);

  if (primaryWorkers[key]) {
    delete primaryWorkers[key];
    writeWorkers(primary, primaryWorkers);
    return { name: key, file: primary };
  }

  if (secondary && exists(secondary) && readWorkers(secondary)[key]) {
    throw new MoError("E_NOT_FOUND", key + " 不在当前范围", {
      hint: "它定义在另一个作用域，加上 " + (project ? "去掉 --project" : "--project") + " 再试",
    });
  }

  throw new MoError("E_NOT_FOUND", "没有这个 worker：" + key);
}
