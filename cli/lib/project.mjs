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
      "# 回执、日志、派单脚本与信封默认不入库（按需 git add -f）\nreceipts/\nlogs/\nenvelopes/\nruns/\n",
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

/**
 * 只找项目根，不认领、不登记。
 * 给"只想写文件"的命令用（mo project agent）：在 git 根上也能工作，
 * 但不该顺手创建 .mo-agent/project.json——那是建卡时才发生的事（B1.2）。
 */
export function resolveRoot(options = {}) {
  const cwd = options.cwd || process.cwd();
  const home = options.home || moHome();
  const target = options.target;

  if (target && target !== true) {
    if (looksLikePath(String(target))) {
      const dir = path.resolve(cwd, String(target));
      if (!exists(dir)) throw new MoError("E_PROJECT_NOT_FOUND", "路径不存在：" + dir);
      const root = findProjectRoot(dir) || findGitRoot(dir);
      if (!root) throw new MoError("E_PROJECT_NOT_FOUND", dir + " 既不是 git 仓库，也不是 mo 项目");
      return { root };
    }
    return { root: resolveProject({ cwd, target, home, autoAttach: false }).root };
  }

  const root = findProjectRoot(cwd) || findGitRoot(cwd);
  if (!root) {
    throw new MoError("E_PROJECT_UNBOUND", "当前目录不属于任何项目，也不是 git 仓库", {
      hint: "在仓库根目录执行，或用 --project <路径>",
    });
  }
  return { root };
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
/**
 * 找一条已登记的项目；只查注册表，不认领、不登记。
 * 目标可以是 id、名称、或路径；缺省用 cwd 所属项目。
 */
/** macOS 下 /var 与 /private/var 指同一处，比较路径前先归一 */
function canonical(value) {
  try {
    return fs.realpathSync(path.resolve(value));
  } catch {
    return path.resolve(value);
  }
}

export function findRegisteredProject(options = {}) {
  const cwd = options.cwd || process.cwd();
  const home = options.home || moHome();
  const target = options.target;
  const registry = readRegistry(home);

  if (target && target !== true) {
    if (looksLikePath(String(target))) {
      const dir = path.resolve(cwd, String(target));
      const root = findProjectRoot(dir) || (exists(dir) ? dir : null);
      const meta = root ? readProjectMeta(root) : null;
      if (meta && registry.projects[meta.id]) {
        return { root, id: meta.id, entry: registry.projects[meta.id], registry, home };
      }
      const want = canonical(dir);
      const hit = Object.entries(registry.projects).find(([, entry]) =>
        (entry.paths || []).some((candidate) => canonical(candidate) === want),
      );
      if (hit) return { root: dir, id: hit[0], entry: hit[1], registry, home };
      throw new MoError("E_PROJECT_NOT_FOUND", "没有登记这个路径：" + dir, {
        hint: "mo project list 看已登记项目",
      });
    }

    const needle = String(target).toLowerCase();
    const matches = Object.entries(registry.projects).filter(
      ([id, entry]) => id.toLowerCase() === needle || String(entry.name || "").toLowerCase() === needle,
    );
    if (!matches.length) {
      throw new MoError("E_PROJECT_NOT_FOUND", "找不到项目：" + target, {
        hint: "mo project list 看已登记项目",
      });
    }
    if (matches.length > 1) {
      throw new MoError("E_PROJECT_AMBIGUOUS", "项目名 " + target + " 命中多个，请改用 id", {
        candidates: matches.map(([id, entry]) => ({ id, name: entry.name, paths: entry.paths })),
      });
    }
    return { root: null, id: matches[0][0], entry: matches[0][1], registry, home };
  }

  const root = findProjectRoot(cwd);
  const meta = root ? readProjectMeta(root) : null;
  if (!meta || !registry.projects[meta.id]) {
    throw new MoError("E_PROJECT_UNBOUND", "当前目录不属于任何已登记项目", {
      hint: "mo project list 看已登记项目，或指定名称 / 路径",
    });
  }
  return { root, id: meta.id, entry: registry.projects[meta.id], registry, home };
}

/**
 * 移除登记。
 * 默认只动注册表（~/.mo-agent/projects.json），不碰仓库里的任何文件；
 * purge=true 才会删 <repo>/.mo-agent/——这一步由命令层做安全确认。
 */
export function removeProject(options = {}) {
  const found = findRegisteredProject(options);
  const requested = options.pathOnly
    ? canonical(path.resolve(options.cwd || process.cwd(), String(options.pathOnly)))
    : null;
  const paths = found.entry.paths || [];
  const matched = requested ? paths.find((candidate) => canonical(candidate) === requested) : null;

  if (requested && !matched) {
    throw new MoError("E_PROJECT_NOT_FOUND", "这个路径没有登记在项目 " + found.id + " 下：" + options.pathOnly, {
      hint: "登记的位置：" + (paths.join(", ") || "（无）"),
    });
  }
  if (options.purge && !requested && paths.length > 1) {
    throw new MoError("E_USAGE", "这个项目登记了 " + paths.length + " 个位置，--purge 需要配合 --path 指定一个", {
      hint: paths.join("\n"),
    });
  }

  const removedPaths = matched ? [matched] : paths.slice();
  const remainingPaths = paths.filter((candidate) => !removedPaths.includes(candidate));
  const dryRun = Boolean(options.dryRun);

  if (!dryRun) {
    if (remainingPaths.length) {
      found.entry.paths = remainingPaths;
      found.entry.lastSeen = new Date().toISOString();
    } else {
      delete found.registry.projects[found.id];
    }
    writeRegistry(found.registry, found.home);
  }

  return {
    id: found.id,
    name: found.entry.name || null,
    removedPaths,
    remainingPaths,
    dryRun,
    purged: false,
  };
}

/** 删掉一个仓库里的 .mo-agent/（由命令层确认后再调） */
export function purgeProjectDir(root) {
  const dir = projectDir(root);
  if (!exists(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
