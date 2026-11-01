import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

/**
 * 流式下载到文件：边下边算 sha256，失败不留下半个文件。
 * APK 与 host 运行时都用它——大文件不该整个读进内存。
 *
 * @returns {Promise<{path: string, bytes: number, sha256: string}>}
 */
export async function downloadToFile(url, dest, options) {
  const opts = options || {};
  const headers = opts.headers || {};
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const expectedTotal = Number(opts.total) || 0;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("下载失败：" + res.status + " " + url);
  if (!res.body) throw new Error("下载失败：响应没有 body");

  const total = Number(res.headers.get("content-length")) || expectedTotal || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  const hash = createHash("sha256");
  let received = 0;

  try {
    const out = fs.createWriteStream(tmp, { mode: 0o644 });
    for await (const chunk of Readable.fromWeb(res.body)) {
      received += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
      if (onProgress) onProgress(received, total);
    }
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }

  return { path: tmp, bytes: received, sha256: hash.digest("hex") };
}

/** 下载 + 校验 + 原子 rename。sha 不匹配就删掉临时文件并抛错。 */
export async function downloadVerified(url, dest, options) {
  const opts = options || {};
  const result = await downloadToFile(url, dest, opts);
  if (opts.expectedSha256) {
    const expected = String(opts.expectedSha256).toLowerCase();
    if (expected !== result.sha256) {
      fs.rmSync(result.path, { force: true });
      throw new Error("校验和不匹配：" + dest);
    }
  }
  fs.renameSync(result.path, dest);
  return { ...result, path: dest };
}
