// 从 GitHub Releases 下载最新 APK 到 ~/.mo-agent/app.apk。
// host 的 /app.apk 会在没有"打包进运行时"的那份时回退到这个路径。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

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
  const bin = await fetch(picked.asset.browser_download_url, { headers });
  if (!bin.ok) throw new Error("下载 APK 失败：" + bin.status);

  // 边下边写，顺带算 sha256：30MB 级的文件不该整个塞内存，也才有进度可看
  const total = Number(bin.headers.get("content-length")) || Number(picked.asset.size) || 0;
  const showProgress = options.progress !== false && Boolean(process.stderr.isTTY);
  const mb = (n) => (n / 1048576).toFixed(1);
  const paint = (received) => {
    if (!showProgress) return;
    const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
    const text = pct === null
      ? "  " + mb(received) + " MB"
      : "  " + pct + "%（" + mb(received) + " / " + mb(total) + " MB）";
    process.stderr.write("\r  下载 " + picked.asset.name + text + "   ");
  };

  if (!bin.body) throw new Error("下载 APK 失败：响应没有 body");

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  const hash = createHash("sha256");
  let received = 0;
  try {
    const out = fs.createWriteStream(tmp, { mode: 0o644 });
    for await (const chunk of Readable.fromWeb(bin.body)) {
      received += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
      paint(received);
    }
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    if (showProgress) process.stderr.write("\n");
    throw error;
  }
  if (showProgress) {
    process.stderr.write("\n");
    log("  下载完成 " + mb(received) + " MB");
  }

  const actual = hash.digest("hex");
  if (picked.sha) {
    const shaRes = await fetch(picked.sha.browser_download_url, { headers });
    if (shaRes.ok) {
      const expected = (await shaRes.text()).trim().split(/\s+/)[0].toLowerCase();
      if (expected !== actual) {
        fs.rmSync(tmp, { force: true });
        throw new Error("APK 校验和不匹配");
      }
      log("✓ 校验和通过");
    }
  }

  fs.renameSync(tmp, dest);
  return { path: dest, downloaded: true, bytes: received };
}
