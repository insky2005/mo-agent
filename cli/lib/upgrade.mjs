/**
 * CLI 自升级：查 GitHub Releases 上的最新 cli-v*，下载本平台产物，
 * 校验 sha256、试跑 --version，再用同目录 rename 原子替换当前二进制。
 *
 * 产物命名与 installer/get-cli.sh、.github/workflows/cli-release.yml 一致：
 *   mo-<darwin|linux|windows>-<arm64|x64>[.exe]
 *
 * 只替换单文件二进制。源码运行（node cli/mo.mjs / bun cli/mo.mjs）和 npm 全局安装
 * 都不自替换：那会改到 node_modules 或他人的 node，而不是用户真正在跑的东西。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { MoError } from "../../core/errors.mjs";
import { VERSION } from "./version.mjs";
import { moHome } from "./paths.mjs";

export const DEFAULT_REPO = "insky2005/mo-agent";
export const RELEASES_API = "https://api.github.com";

/** 单个 CLI 产物上限，避免把异常响应整个读进内存 */
const MAX_BYTES = 256 * 1024 * 1024;

const OS_NAMES = { darwin: "darwin", linux: "linux", win32: "windows" };

/** 当前平台对应的 Release 资产名（windows 带 .exe） */
export function assetName(platform = process.platform, arch = process.arch) {
  const osName = OS_NAMES[platform];
  const archName = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!osName || !archName) {
    throw new MoError("E_UPGRADE_UNSUPPORTED", "没有 " + platform + "-" + arch + " 的 CLI 产物", {
      hint: "支持 darwin / linux / windows + arm64 / x64；其它平台请从源码构建",
    });
  }
  return "mo-" + osName + "-" + archName + (platform === "win32" ? ".exe" : "");
}

/** 解析 "0.3.0" / "v0.3.0" / "cli-v0.3.0"（可带 -rc.1 预发布后缀） */
export function parseVersion(text) {
  const match = String(text || "").trim().match(/^(?:cli-)?v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    raw: String(text).trim(),
    // 纯版本号（去掉 cli-v 前缀），用于展示、比较和"新产物自报版本"
    version: match[1] + "." + match[2] + "." + match[3] + (match[4] ? "-" + match[4] : ""),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

function parseOrThrow(text) {
  const parsed = parseVersion(text);
  if (!parsed) throw new MoError("E_UPGRADE_VERSION", "看不懂的版本号：" + text, { hint: "例：cli-v0.3.0 / 0.3.0" });
  return parsed;
}

/** 语义化版本比较：返回 -1 / 0 / 1；预发布版小于同号正式版 */
export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseOrThrow(left) : parseOrThrow(left.raw);
  const b = typeof right === "string" ? parseOrThrow(right) : parseOrThrow(right.raw);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && !b.prerelease) return 0;
  if (a.prerelease === b.prerelease) return 0;
  // 预发布标识按点分段比较：数字段按数值，其余按字典序
  const leftParts = a.prerelease.split(".");
  const rightParts = b.prerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index];
    const y = rightParts[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** "0.4.0" / "v0.4.0" / "cli-v0.4.0" → 统一成 cli-v0.4.0 */
export function normalizeTag(value) {
  const text = String(value || "").trim();
  if (!text) throw new MoError("E_USAGE", "缺少版本号", { hint: "例：mo upgrade --version cli-v0.3.0" });
  if (/^cli-v\d/.test(text)) {
    parseOrThrow(text);
    return text;
  }
  if (/^v?\d/.test(text)) {
    parseOrThrow(text);
    return "cli-" + (text.startsWith("v") ? text : "v" + text);
  }
  throw new MoError("E_UPGRADE_VERSION", "不是 CLI 版本号：" + text, { hint: "CLI 的 tag 形如 cli-v0.3.0" });
}

/**
 * 从 Release 列表里挑：tag 必须是 cli-v*、带本平台资产、版本最高。
 * apk-v* / desktop-v* 会被过滤掉，不靠"列表顺序"猜。
 */
export function pickRelease(releases, asset) {
  let best = null;
  for (const release of releases || []) {
    const tag = String(release.tag_name || release.tag || "");
    if (!/^cli-v/i.test(tag)) continue;
    const version = parseVersion(tag);
    if (!version) continue;
    const assets = release.assets || [];
    const found = assets.find((entry) => entry && entry.name === asset);
    if (!found) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = {
        tag,
        version,
        asset: found,
        sha256: assets.find((entry) => entry && entry.name === asset + ".sha256") || null,
      };
    }
  }
  return best;
}

/** 判断当前 mo 是怎么装的：binary / source / npm / unknown */
export function detectInstall(options = {}) {
  const execPath = options.execPath || process.execPath;
  const argv = options.argv || process.argv;
  const bun = options.bun !== undefined ? Boolean(options.bun) : Boolean(process.versions.bun);
  const base = path.basename(execPath).toLowerCase();

  if (base === "mo" || base === "mo.exe") return { mode: "binary", path: execPath };
  if (bun) {
    if (base === "bun" || base === "bun.exe") {
      return { mode: "source", path: String(argv[1] || execPath), hint: "bun cli/mo.mjs" };
    }
    // bun --compile 出来的产物可能被改名，仍然可以自替换
    return { mode: "binary", path: execPath };
  }
  if (/^node(\.exe)?$/.test(base)) {
    const script = String(argv[1] || "");
    if (/[\\/]node_modules[\\/]/.test(script)) return { mode: "npm", path: script };
    return { mode: "source", path: script };
  }
  return { mode: "unknown", path: execPath };
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 校验 .sha256 文件内容；不匹配抛 E_UPGRADE_CHECKSUM */
export function verifyChecksum(bytes, checksumText) {
  const expected = String(checksumText || "").trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new MoError("E_UPGRADE_CHECKSUM", "校验文件格式不对", { hint: "期望 64 位十六进制 sha256" });
  }
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new MoError("E_UPGRADE_CHECKSUM", "下载的 mo 校验和不匹配，已放弃替换", {
      hint: "期望 " + expected + "，实际 " + actual,
    });
  }
  return actual;
}

function githubHeaders(env = process.env) {
  const headers = { "User-Agent": "mo-agent", Accept: "application/vnd.github+json" };
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

async function readJson(response, what) {
  try {
    return await response.json();
  } catch {
    throw new MoError("E_UPGRADE_NETWORK", what + "返回的不是 JSON", { hint: "检查网络或代理，或稍后重试" });
  }
}

async function readBytes(response, what, maxBytes) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new MoError("E_UPGRADE_NETWORK", what + "超过 " + Math.round(maxBytes / 1024 / 1024) + "MB，已放弃");
  }
  return buffer;
}

/** 拉最近 30 个 Release（足够覆盖几个组件的 tag 混排） */
export async function fetchReleases(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new MoError("E_UPGRADE_NETWORK", "当前运行时不支持 fetch，无法检查新版本");
  }
  const url = RELEASES_API + "/repos/" + repo + "/releases?per_page=30";
  const response = await fetchImpl(url, { headers: githubHeaders(options.env) });
  if (!response || !response.ok) {
    const status = response ? response.status : "无响应";
    throw new MoError("E_UPGRADE_NETWORK", "查询 Release 失败：HTTP " + status, {
      hint: "仓库是否公开？GitHub API 可能限流，稍后重试或设置 GITHUB_TOKEN",
    });
  }
  const parsed = await readJson(response, "Release 列表");
  if (!Array.isArray(parsed)) throw new MoError("E_UPGRADE_NETWORK", "Release 列表格式不对");
  return parsed;
}

/** 下载资产并校验；没有 .sha256 的版本直接拒绝安装 */
export async function downloadRelease(options = {}) {
  const picked = options.picked;
  const fetchImpl = options.fetch || globalThis.fetch;
  const headers = githubHeaders(options.env);
  const maxBytes = options.maxBytes || MAX_BYTES;
  const name = picked.asset.name;

  const response = await fetchImpl(picked.asset.browser_download_url, { headers });
  if (!response || !response.ok) {
    const status = response ? response.status : "无响应";
    throw new MoError("E_UPGRADE_NETWORK", "下载 " + name + " 失败：HTTP " + status);
  }
  const bytes = await readBytes(response, name, maxBytes);

  if (!picked.sha256) {
    throw new MoError("E_UPGRADE_CHECKSUM", "这个 Release 缺少 " + name + ".sha256，拒绝安装", {
      hint: "重新跑一次发布 workflow 生成校验文件",
    });
  }
  const checksumResponse = await fetchImpl(picked.sha256.browser_download_url, { headers });
  if (!checksumResponse || !checksumResponse.ok) {
    throw new MoError("E_UPGRADE_CHECKSUM", "下载 " + picked.sha256.name + " 失败");
  }
  verifyChecksum(bytes, await checksumResponse.text());
  return bytes;
}

/**
 * 落盘并替换。同目录 rename 保证"要么旧文件、要么新文件"。
 *
 * verifyRun 为真时先在临时文件上跑 --version，产物跑不起来就不替换。
 */
export function installBinary(options = {}) {
  const bytes = options.bytes;
  const target = options.target;
  const platform = options.platform || process.platform;
  const mode = options.mode || 0o755;
  const verifyRun = options.verifyRun !== false;
  const expectVersion = options.expectVersion || null;
  const timeoutMs = options.timeoutMs || 15000;

  if (!target) throw new MoError("E_UPGRADE_TARGET", "不知道要替换哪个文件");
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const temp = path.join(dir, "." + path.basename(target) + ".tmp-" + process.pid + "-" + Date.now());
  try {
    fs.writeFileSync(temp, bytes, { mode });
    fs.chmodSync(temp, mode);

    if (verifyRun) {
      const run = spawnSync(temp, ["--version"], { encoding: "utf8", timeout: timeoutMs });
      if (run.error || run.status !== 0) {
        throw new MoError("E_UPGRADE_VERIFY", "新产物跑不起来，已放弃替换", {
          hint: (run.error && run.error.message) || String(run.stderr || "").trim() || "exit " + run.status,
        });
      }
      if (expectVersion) {
        const actual = String(run.stdout || "").trim().split("\n")[0].trim();
        if (actual !== expectVersion) {
          throw new MoError("E_UPGRADE_VERIFY", "新产物报的版本不对：" + actual, {
            hint: "期望 " + expectVersion + "，已放弃替换",
          });
        }
      }
    }

    if (platform === "win32" && fs.existsSync(target)) {
      // Windows 不能覆盖正在运行的 exe：先改名，再落新文件，最后尽力删旧文件
      const backup = target + ".old-" + Date.now();
      fs.renameSync(target, backup);
      try {
        fs.renameSync(temp, target);
      } catch (error) {
        fs.renameSync(backup, target);
        throw error;
      }
      try {
        fs.rmSync(backup, { force: true });
      } catch {
        // 旧文件可能还被别的进程占着，下次升级再清理
      }
    } else {
      fs.renameSync(temp, target);
    }
  } finally {
    try {
      if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    } catch {
      // 清理失败不影响已经完成的替换
    }
  }
  return { target };
}

export function checkCachePath(home = moHome()) {
  return path.join(home, "upgrade-check.json");
}

/** 最近的检测结果；读不到或坏了都当没有（只是提示，不值得报错） */
export function readCheckCache(home = moHome()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkCachePath(home), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCheckCache(home, value) {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(checkCachePath(home), JSON.stringify(value, null, 2) + "\n");
  } catch {
    // 缓存只是提示，写不进去不影响升级本身
  }
}

/** mo doctor 用：缓存里是否有比当前更新的版本（不联网） */
export function cachedUpdate(home = moHome(), current = VERSION) {
  const cache = readCheckCache(home);
  if (!cache || !cache.latest) return null;
  let latest;
  try {
    latest = parseOrThrow(cache.latest);
    const currentVersion = parseOrThrow(current);
    if (compareVersions(latest, currentVersion) <= 0) return null;
  } catch {
    return null;
  }
  return { checkedAt: cache.checkedAt || null, tag: cache.tag || null, latest: latest.version };
}

/**
 * 检查并升级。所有副作用都走参数注入，测试里换 fetch / target 即可。
 *
 * @returns {{current, latest, tag, asset, updateAvailable, installed, dryRun, checkOnly, skipped, path}}
 */
export async function runUpgrade(options = {}) {
  const current = options.current || VERSION;
  const checkOnly = Boolean(options.checkOnly);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const version = options.version || null;
  const repo = options.repo || DEFAULT_REPO;
  const fetchImpl = options.fetch || globalThis.fetch;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const asset = options.asset || assetName(platform, arch);
  const home = options.home || moHome();
  const log = options.log || (() => {});
  const install = options.install || detectInstall();

  // 先确认能自替换，再去联网/下载：源码运行不该白跑一趟网络
  if (!checkOnly && install.mode !== "binary") {
    const hint =
      install.mode === "npm"
        ? "npm 全局安装请用：npm i -g github:" + repo
        : install.mode === "source"
          ? "源码运行：git pull 后 bash scripts/install-cli.sh"
          : "没识别出安装方式，重跑安装脚本更稳妥";
    throw new MoError("E_UPGRADE_SOURCE", "当前 mo 不是单文件二进制（" + (install.path || install.mode) + "），不能自替换", { hint });
  }

  let picked;
  if (version) {
    const tag = normalizeTag(version);
    const parsed = parseOrThrow(tag);
    const url = "https://github.com/" + repo + "/releases/download/" + tag + "/" + asset;
    picked = {
      tag,
      version: parsed,
      asset: { name: asset, browser_download_url: url },
      sha256: { name: asset + ".sha256", browser_download_url: url + ".sha256" },
    };
  } else {
    const releases = await fetchReleases({ repo, fetch: fetchImpl, env: options.env });
    picked = pickRelease(releases, asset);
    if (!picked) {
      throw new MoError("E_UPGRADE_NO_RELEASE", "还没发布过带 " + asset + " 的 CLI 版本", {
        hint: "等 CI 发完 cli-v*；或到 Release 页确认资产名",
      });
    }
  }

  const comparison = compareVersions(picked.version, parseOrThrow(current));
  const result = {
    current,
    latest: picked.version.version,
    tag: picked.tag,
    asset: picked.asset.name,
    updateAvailable: comparison > 0,
    installed: false,
    dryRun,
    checkOnly,
    path: install.path || null,
  };

  const remember = (latestVersion) =>
    writeCheckCache(home, {
      checkedAt: new Date().toISOString(),
      current: latestVersion,
      latest: picked.version.version,
      tag: picked.tag,
    });

  if (checkOnly) {
    remember(current);
    return { ...result, skipped: comparison > 0 ? null : comparison === 0 ? "up-to-date" : "local-newer" };
  }

  if (comparison === 0 && !force) {
    remember(current);
    return { ...result, skipped: "up-to-date" };
  }
  if (comparison < 0) {
    if (!version) {
      remember(current);
      return { ...result, skipped: "local-newer" };
    }
    if (!force) {
      throw new MoError("E_UPGRADE_DOWNGRADE", "当前 " + current + " 比目标 " + picked.version.version + " 新", {
        hint: "确实要降级就加 --force",
      });
    }
  }

  try {
    fs.accessSync(path.dirname(install.path), fs.constants.W_OK);
  } catch {
    throw new MoError("E_UPGRADE_PERMISSION", "没有写权限：" + path.dirname(install.path), {
      hint: "用 sudo 重跑；或 MO_BIN_DIR=~/some/bin 重新安装到用户目录",
    });
  }

  if (dryRun) return { ...result, wouldInstall: true };

  log("下载 " + picked.asset.name + " …");
  const bytes = await downloadRelease({ picked, fetch: fetchImpl, env: options.env });
  installBinary({
    bytes,
    target: install.path,
    platform,
    expectVersion: picked.version.version,
    verifyRun: options.verifyRun !== false,
  });

  remember(picked.version.version);
  return { ...result, installed: true, bytes: bytes.length };
}
