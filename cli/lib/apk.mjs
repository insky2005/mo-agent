// 从 GitHub Releases 下载最新 APK 到 ~/.mo-agent/app.apk。
// host 的 /app.apk 会在没有"打包进运行时"的那份时回退到这个路径。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadVerified } from "./download.mjs";

const DEFAULT_REPO = "insky2005/mo-agent";

export function apkDest(home = os.homedir()) {
  return path.join(home, ".mo-agent", "app.apk");
}

function pickApkAsset(releases) {
  for (const release of releases) {
    for (const asset of release.assets || []) {
      if (/^mo-agent-android-.+\.apk$/.test(asset.name)) {
        const sha = (release.assets || []).find((a) => a.name === asset.name + ".sha256");
        return { asset, sha };
      }
    }
  }
  return null;
}

/**
 * 确保本机有一份 APK。已存在就不重复下载。
 * @returns {Promise<{path:string, downloaded:boolean, skipped?:string}>}
 */
export async function fetchApk(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const dest = apkDest(home);

  if (fs.existsSync(dest)) return { path: dest, downloaded: false, skipped: "已存在" };

  const repo = env.MO_AGENT_REPO || DEFAULT_REPO;
  const headers = { "User-Agent": "mo-agent", Accept: "application/vnd.github+json" };

  const res = await fetch("https://api.github.com/repos/" + repo + "/releases?per_page=20", { headers });
  if (!res.ok) throw new Error("查询 Release 失败：" + res.status);
  const picked = pickApkAsset(await res.json());
  if (!picked) throw new Error("还没有发布过 APK（需要先推 apk-v* tag）");

  log("下载 " + picked.asset.name + " …");
  const showProgress = options.progress !== false && Boolean(process.stderr.isTTY);
  const mb = (n) => (n / 1048576).toFixed(1);
  let sha = null;
  if (picked.sha) {
    const shaRes = await fetch(picked.sha.browser_download_url, { headers });
    if (shaRes.ok) sha = (await shaRes.text()).trim().split(/\s+/)[0].toLowerCase();
  }

  const result = await downloadVerified(picked.asset.browser_download_url, dest, {
    headers,
    total: picked.asset.size,
    expectedSha256: sha,
    onProgress: showProgress
      ? (received, total) => {
          const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
          const text = pct === null
            ? "  " + mb(received) + " MB"
            : "  " + pct + "%（" + mb(received) + " / " + mb(total) + " MB）";
          process.stderr.write("\r  下载 " + picked.asset.name + text + "   ");
        }
      : null,
  });
  if (showProgress) {
    process.stderr.write("\n");
    log("  下载完成 " + mb(result.bytes) + " MB");
  }
  if (sha) log("✓ 校验和通过");
  return { path: dest, downloaded: true, bytes: result.bytes };
}
