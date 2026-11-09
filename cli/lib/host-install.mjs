import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { downloadVerified } from "./download.mjs";

/**
 * host 运行时的独立安装。
 *
 * 为什么需要它：CLI 是单文件、刻意不含 host；host 的产物原本只随桌面 App 分发。
 * 于是"只装 CLI"的用户拿不到 host —— 手机批准、监控、钉钉全都用不了。
 * 这里把桌面包里那个 runtime.tar.gz 当成独立资产来装，落到 findHost 已经预留的
 * ~/.mo-agent/runtime，装完 `mo daemon start` 就能用。
 */

const DEFAULT_REPO = "insky2005/mo-agent";

export function hostRuntimeDir(home = os.homedir()) {
  return path.join(home, ".mo-agent", "runtime");
}

export function hostBinary(home = os.homedir()) {
  return path.join(hostRuntimeDir(home), "bin", "mo-agent-host");
}

/** 资产名约定：mo-agent-runtime-<os>-<arch>.tar.gz（发布侧必须同名） */
export function runtimeAssetName(options = {}) {
  const platform = options.platform || process.platform;
  const osName = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const arch = options.arch || process.arch;
  const archName = arch === "arm64" ? "arm64" : "x64";
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return "mo-agent-runtime-" + osName + "-" + archName + "." + ext;
}

export function pickRuntimeAsset(releases, name) {
  for (const release of releases || []) {
    for (const asset of release.assets || []) {
      if (asset.name === name) {
        const sha = (release.assets || []).find((item) => item.name === asset.name + ".sha256");
        return { asset, sha, tag: release.tag_name || "" };
      }
    }
  }
  return null;
}

function extract(archive, dest, platform) {
  fs.mkdirSync(dest, { recursive: true });
  const args = platform === "win32"
    ? ["-xf", archive, "-C", dest]
    : ["-xzf", archive, "-C", dest];
  const result = spawnSync(platform === "win32" ? "tar" : "tar", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("解压失败：" + String(result.stderr || "").trim().slice(-300));
  }
}

/**
 * @returns {Promise<{installed: boolean, reused?: boolean, dir: string, bin: string, version?: string}>}
 */
export async function installHost(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const platform = options.platform || process.platform;
  const dir = hostRuntimeDir(home);
  const bin = hostBinary(home);

  if (!options.force && fs.existsSync(bin)) {
    return { installed: false, reused: true, dir, bin };
  }

  const name = runtimeAssetName({ platform, arch: options.arch });
  const headers = { "User-Agent": "mo-agent", Accept: "application/vnd.github+json" };
  let url = String(env.MO_AGENT_HOST_URL || "");
  let expectedSha = String(env.MO_AGENT_HOST_SHA256 || "");
  let version = "";

  if (!url) {
    const repo = env.MO_AGENT_REPO || DEFAULT_REPO;
    const res = await fetch("https://api.github.com/repos/" + repo + "/releases?per_page=30", { headers });
    if (!res.ok) throw new Error("查询 Release 失败：" + res.status);
    const picked = pickRuntimeAsset(await res.json(), name);
    if (!picked) {
      throw new Error("还没有发布 host 运行时（" + name + "）：先跑 ./scripts/build-desktop.sh 并发布该资产，或装桌面版");
    }
    url = picked.asset.browser_download_url;
    version = picked.tag;
    if (picked.sha) {
      const shaRes = await fetch(picked.sha.browser_download_url, { headers });
      if (shaRes.ok) expectedSha = (await shaRes.text()).trim().split(/\s+/)[0].toLowerCase();
    }
  }

  log("下载 host 运行时 " + path.basename(url) + " …");
  const archive = path.join(home, ".mo-agent", ".runtime-download-" + name);
  const showProgress = options.progress !== false && Boolean(process.stderr.isTTY);
  const mb = (n) => (n / 1048576).toFixed(1);

  const result = await downloadVerified(url, archive, {
    headers,
    expectedSha256: expectedSha || null,
    total: options.total,
    onProgress: showProgress
      ? (received, total) => {
          const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
          const text = pct === null ? "  " + mb(received) + " MB" : "  " + pct + "%（" + mb(received) + " / " + mb(total) + " MB）";
          process.stderr.write("\r  下载 host 运行时" + text + "   ");
        }
      : null,
  });
  if (showProgress) process.stderr.write("\n");

  const staging = dir + ".tmp-" + process.pid;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    extract(archive, staging, platform);
    // tar 里的顶层可能是 ./ 形式，也可能带一层目录
    const candidate = path.join(staging, "bin", "mo-agent-host");
    const nested = fs.existsSync(candidate) ? staging : path.join(staging, "runtime");
    if (!fs.existsSync(path.join(nested, "bin", "mo-agent-host"))) {
      throw new Error("压缩包里没有 bin/mo-agent-host，资产可能不是 runtime 包");
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(nested, dir);
    try {
      fs.chmodSync(bin, 0o755);
    } catch {
      // Windows 上忽略
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }

  let installedVersion = version;
  try {
    installedVersion = JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")).version || version;
  } catch {
    // runtime.json 不是必需
  }
  log("host 运行时已就绪：" + dir);
  return { installed: true, dir, bin, version: installedVersion, bytes: result.bytes };
}
