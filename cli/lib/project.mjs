import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { newProjectId } from "./ids.mjs";
import { ensureDir, readJsonSafe, writeJsonAtomic, writeAtomic, exists } from "./fsx.mjs";
import { moHome, projectFile, projectDir } from "./paths.mjs";

function registryPath(home) {
  return path.join(home, "projects.json");
}

export function readRegistry(home = moHome()) {
  const value = readJsonSafe(registryPath(home), null);
  if (!value || typeof value !== "object" || !value.projects) {
    return { version: 1, projects: {} };
  }
  return value;
}

export function writeRegistry(registry, home = moHome()) {
  writeJsonAtomic(registryPath(home), registry);
}

function findUp(start, predicate) {
  let current = path.resolve(start);
  for (;;) {
    if (predicate(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function findProjectRoot(start) {
  return findUp(start, (dir) => exists(projectFile(dir)));
}

export function findGitRoot(start) {
  return findUp(start, (dir) => exists(path.join(dir, ".git")));
}

export function readProjectMeta(root) {
  return readJsonSafe(projectFile(root), null);
}

function defaultName(root) {
  return path.basename(root);
}

/**
 * 给一个目录写入 project.json（身份）并登记到注册表（位置）。
 * 幂等：已有 project.json 就只补登记。
 */
export function attachProject(root, options = {}) {
  const absolute = path.resolve(root);
  if (!exists(absolute)) {
    throw new MoError("E_PROJECT_NOT_FOUND", "目录不存在：" + absolute);
  }
  let meta = readProjectMeta(absolute);
  if (!meta || !meta.id) {
    meta = {
      id: newProjectId(),
      name: options.name || defaultName(absolute),
      created: new Date().toISOString(),
    };
    ensureDir(projectDir(absolute));
    writeJsonAtomic(projectFile(absolute), meta);
    writeAtomic(
      path.join(projectDir(absolute), ".gitignore"),
      "# 回执与执行日志默认不入库（按需 git add -f）\nreceipts/\nlogs/\n",
    );
    writeAtomic(
      path.join(projectDir(absolute), "README.md"),
      [
        "# .mo-agent",
        "",
        "这个目录由 mo-agent 维护：",
        "",
        "- project.json：项目身份证，**要提交**；",
        "- tasks/：任务卡，**要提交**；",
        "- receipts/：执行回执，默认不入库；",
        "- logs/：每次派单的完整日志，默认不入库。",
        "",
      ].join("\n"),
    );
  } else if (options.name && !meta.name) {
    meta.name = options.name;
    writeJsonAtomic(projectFile(absolute), meta);
  }

  const home = options.home || moHome();
  const registry = readRegistry(home);
  const entry = registry.projects[meta.id] || { name: meta.name, paths: [] };
  entry.name = meta.name || entry.name;
  entry.paths = [...new Set([...(entry.paths || []), absolute])];
  entry.lastSeen = new Date().toISOString();
  registry.projects[meta.id] = entry;
  writeRegistry(registry, home);

  return { root: absolute, meta, registry };
}

function looksLikePath(value) {
  return value.startsWith("/") || value.startsWith(".") || value.includes(path.sep);
}

function registerPath(meta, root, home) {
  const registry = readRegistry(home);
  const entry = registry.projects[meta.id] || { name: meta.name, paths: [] };
  const before = JSON.stringify(entry.paths || []);
  entry.paths = [...new Set([...(entry.paths || []), root])];
  entry.lastSeen = new Date().toISOString();
  if (JSON.stringify(entry.paths) !== before || !registry.projects[meta.id]) {
    registry.projects[meta.id] = entry;
    writeRegistry(registry, home);
  }
}

/**
 * 解析目标项目：
 * 1. 显式路径 → 必须已存在；没有 project.json 时按 git 根自动认领
 * 2. 显式名称 / id → 查注册表，多义则报错
 * 3. 未指定 → cwd 向上找；git 根自动认领；否则报 E_PROJECT_UNBOUND
 */
export function resolveProject(options = {}) {
  const cwd = options.cwd || process.cwd();
  const home = options.home || moHome();
  const autoAttach = options.autoAttach !== false;
  const target = options.target;

  if (target && target !== true) {
    if (looksLikePath(String(target))) {
      const dir = path.resolve(cwd, String(target));
      if (!exists(dir)) throw new MoError("E_PROJECT_NOT_FOUND", "路径不存在：" + dir);
      const root = findProjectRoot(dir);
      if (root) {
        const meta = readProjectMeta(root);
        registerPath(meta, root, home);
        return { root, meta, autoAttached: false };
      }
      const gitRoot = findGitRoot(dir);
      if (gitRoot && autoAttach) {
        const attached = attachProject(gitRoot, { home });
        return { root: attached.root, meta: attached.meta, autoAttached: true };
      }
      throw new MoError("E_PROJECT_NOT_FOUND", dir + " 还不是项目：没有 .mo-agent/project.json");
    }

    const registry = readRegistry(home);
    const needle = String(target).toLowerCase();
    const matches = Object.entries(registry.projects).filter(([id, entry]) => {
      if (id.toLowerCase() === needle) return true;
      return String(entry.name || "").toLowerCase() === needle;
    });
    if (matches.length === 1) {
      const [id, entry] = matches[0];
      const root = (entry.paths || []).find((candidate) => exists(candidate));
      if (!root) {
        throw new MoError(
          "E_PROJECT_MISSING",
          "项目 " + (entry.name || id) + " 的目录已不存在，先 mo project init <新路径>",
        );
      }
      return { root, meta: readProjectMeta(root), autoAttached: false };
    }
    if (matches.length > 1) {
      throw new MoError("E_PROJECT_AMBIGUOUS", "项目名 " + target + " 命中多个，请改用 id", {
        candidates: matches.map(([id, entry]) => ({ id, name: entry.name, paths: entry.paths })),
      });
    }
    throw new MoError("E_PROJECT_NOT_FOUND", "找不到项目：" + target, {
      hint: "用 mo project list 查看已登记项目，或用 mo project init <路径> 登记",
    });
  }

  const root = findProjectRoot(cwd);
  if (root) {
    const meta = readProjectMeta(root);
    registerPath(meta, root, home);
    return { root, meta, autoAttached: false };
  }
  const gitRoot = findGitRoot(cwd);
  if (gitRoot && autoAttach) {
    const attached = attachProject(gitRoot, { home });
    return { root: attached.root, meta: attached.meta, autoAttached: true };
  }
  throw new MoError("E_PROJECT_UNBOUND", "当前目录不属于任何项目", {
    hint: "在项目目录里执行，或 mo project init <路径>，或 --project <名称|路径>",
    cwd,
  });
}

export function machineName() {
  const name = os.hostname().split(".")[0];
  return name || "unknown";
}

export function listProjects(home = moHome()) {
  const registry = readRegistry(home);
  return Object.entries(registry.projects).map(([id, entry]) => ({
    id,
    name: entry.name,
    paths: entry.paths || [],
    missing: !(entry.paths || []).some((candidate) => fs.existsSync(candidate)),
    lastSeen: entry.lastSeen,
  }));
}