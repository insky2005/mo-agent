import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MoError } from "../../core/errors.mjs";
import { ROUTER_ERROR } from "../../core/router.mjs";
import { readJsonSafe, writeFilePrivate, writeJsonPrivate } from "./fsx.mjs";
import { RUNTIMES, runtimeManifest } from "./runtimes.mjs";
import { resolveNode } from "./node.mjs";
import { runtimeInstallDir, runtimeRoot } from "./paths.mjs";

/**
 * Router 运行时的私有安装。
 *
 * 版本 pin 在 runtimes.mjs，**不是 latest**：运行时的 CLI 契约（--tools / mcp）
 * 会随版本漂移，Router 的行为不能变成"用户机器上 npm 装了什么"的函数。
 *
 * 安装是原子的：先装到 <target>.tmp-*，自检通过再 rename；失败不留半个安装。
 * npm 用私有 cache，避免用户 ~/.npm 损坏时把安装拖下水（实测踩过）。
 */

/**
 * 清单只从模块里来，不做任何文件读取——单文件二进制里没有 runtimes.json。
 * 想换版本就改 runtimes.mjs，跟着 mo 的版本走。
 */
export function loadManifest() {
  return RUNTIMES;
}

export function manifestFor(id) {
  const entry = runtimeManifest(id || "pi");
  if (!entry || !entry.package || !entry.version) {
    throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "清单里没有运行时：" + (id || "pi"));
  }
  return entry;
}

export function runtimeBinPath(installDir) {
  return path.join(installDir, "bin", "pi");
}

export function listRuntimes(options) {
  const opts = options || {};
  const home = opts.home;
  const env = opts.env || process.env;
  const base = path.join(runtimeRoot({ home, env, platform: opts.platform }), "routers", "pi");
  let versions = [];
  try {
    versions = fs.readdirSync(base).filter((name) => !name.includes(".tmp-"));
  } catch {
    return { base, runtimes: [] };
  }
  const runtimes = versions
    .map((version) => {
      const dir = path.join(base, version);
      const bin = runtimeBinPath(dir);
      const record = readJsonSafe(path.join(dir, "install.json"), null);
      return { version, dir, bin, installed: fs.existsSync(bin), record };
    })
    .sort((a, b) => String(b.version).localeCompare(String(a.version)));
  return { base, runtimes };
}

function runNpm(command, args, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // 已经退出
      }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs || 300000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + "\n" + (error.message || String(error)), spawnError: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** 校验一个已装好的运行时：能跑，且版本与清单一致 */
export async function verifyRuntime(options) {
  const opts = options || {};
  const nodePath = opts.node;
  const cliPath = opts.cli;
  const expected = opts.expectedVersion;
  if (!nodePath || !cliPath || !fs.existsSync(cliPath)) {
    return { ok: false, reason: "运行时文件缺失" };
  }
  const result = await runNpm(nodePath, [cliPath, "--version"], { env: process.env, timeoutMs: 30000 });
  const text = String(result.stdout || "").trim();
  if (result.code !== 0 || !text) {
    return { ok: false, reason: "运行时跑不起来（退出码 " + result.code + "）", stderr: result.stderr };
  }
  if (expected && !text.startsWith(expected)) {
    return { ok: false, reason: "版本不符：期望 " + expected + "，实际 " + text };
  }
  return { ok: true, version: text.split("\n")[0] };
}

export function writeShim(installDir, nodePath, cliPath) {
  const binDir = path.join(installDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const shim = [
    "#!/bin/sh",
    "# 由 mo router 生成：把运行时固定到某个 Node，避免受 PATH 上的 node 影响",
    'exec "' + nodePath + '" "' + cliPath + '" "$@"',
    "",
  ].join("\n");
  writeFilePrivate(runtimeBinPath(installDir), shim, 0o755);
  return runtimeBinPath(installDir);
}

/**
 * 安装运行时到 <runtimeRoot>/routers/<id>/<version>。
 * @returns {{installed: boolean, version: string, dir: string, bin: string, node: string, reused?: boolean}}
 */
export async function installRuntime(options) {
  const opts = options || {};
  const home = opts.home;
  const env = opts.env || process.env;
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const id = opts.id || "pi";
  const manifest = manifestFor(id, opts.manifestFile);
  const version = String(opts.version || manifest.version);
  const platform = opts.platform;

  const target = runtimeInstallDir({ home, env, platform, id, version });
  const existingBin = runtimeBinPath(target);
  if (!opts.force && fs.existsSync(existingBin)) {
    return { installed: false, reused: true, version, dir: target, bin: existingBin, node: null };
  }

  const node = resolveNode({ env, required: manifest.engines && manifest.engines.node });
  if (!node.ok) {
    throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "找不到满足要求的 Node（" + node.required + "）", {
      hint: "装一个 Node " + node.required + "，或设 MO_ROUTER_NODE 指向它。已尝试：" + node.found.join(" / "),
    });
  }

  const staging = target + ".tmp-" + process.pid + "-" + Date.now();
  const cacheDir = path.join(runtimeRoot({ home, env, platform }), "npm-cache");
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  log.info("安装 Router 运行时 " + id + " " + version + "（Node " + node.version + "）");

  try {
    const npm = String(env.MO_ROUTER_NPM || "npm");
    const args = [
      "install",
      "--prefix", staging,
      "--cache", cacheDir,
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--loglevel", "error",
      manifest.package + "@" + version,
    ];
    const npmEnv = { ...process.env, npm_config_update_notifier: "false" };
    if (env.MO_ROUTER_NPM_REGISTRY) npmEnv.npm_config_registry = String(env.MO_ROUTER_NPM_REGISTRY);
    const result = await runNpm(npm, args, { env: npmEnv, timeoutMs: opts.timeoutMs });
    if (result.code !== 0) {
      throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "npm 安装失败（退出码 " + result.code + "）", {
        hint: "检查网络与 " + npm + " 是否可用；私有 cache 在 " + cacheDir,
        detail: String(result.stderr || "").slice(-1500) || null,
      });
    }

    const packageDir = path.join(staging, "node_modules", manifest.package);
    const cliPath = path.join(packageDir, manifest.bin);
    if (!fs.existsSync(cliPath)) {
      throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "安装产物里没有 " + manifest.bin);
    }

    const verified = await verifyRuntime({ node: node.path, cli: cliPath, expectedVersion: version });
    if (!verified.ok) {
      throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "安装后自检失败：" + verified.reason);
    }

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);

    // shim 必须用最终路径：staging 目录 rename 之后就没了，写死 staging 会得到一个坏的启动器
    const finalCli = path.join(target, "node_modules", manifest.package, manifest.bin);
    writeShim(target, node.path, finalCli);
    writeJsonPrivate(path.join(target, "install.json"), {
      v: 1,
      id,
      package: manifest.package,
      version,
      cli: finalCli,
      node: node.path,
      nodeVersion: node.version,
      installedAt: new Date().toISOString(),
    });

    // 装完再验一次：验证的是最终形态（shim + 最终路径），不是 staging
    const finalCheck = await verifyRuntime({
      node: node.path,
      cli: finalCli,
      expectedVersion: version,
    });
    if (!finalCheck.ok) {
      fs.rmSync(target, { recursive: true, force: true });
      throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "安装后终检失败：" + finalCheck.reason);
    }
    log.info("Router 运行时已就绪：" + target);
    return { installed: true, version, dir: target, bin: runtimeBinPath(target), node: node.path, nodeVersion: node.version };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** 清掉旧版本，只留 keep 里列出的（默认留清单版本 + 当前在用版本） */
export function pruneRuntimes(options) {
  const opts = options || {};
  const home = opts.home;
  const env = opts.env || process.env;
  const keep = new Set((opts.keep || []).map(String));
  const listed = listRuntimes({ home, env, platform: opts.platform });
  const removed = [];
  for (const item of listed.runtimes) {
    if (keep.has(String(item.version))) continue;
    fs.rmSync(item.dir, { recursive: true, force: true });
    removed.push(item.version);
  }
  return { removed, kept: [...keep] };
}
