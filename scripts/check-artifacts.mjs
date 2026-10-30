#!/usr/bin/env node
// 扫描构建产物，确认没有把 HMS App Secret / 第三方密钥打进去。
//
//   node scripts/check-artifacts.mjs desktop/runtime.tar.gz        # 只警告
//   node scripts/check-artifacts.mjs --enforce desktop/runtime.tar.gz
//
// 本地带密钥的包是允许的（SEC-001 的取舍），所以默认只报警；
// CI / 发布前必须加 --enforce，命中即失败。
//
// 归档会递归解开（.app -> .tar.zst -> runtime.tar.gz 这种嵌套也能扫到），
// 所以扫描大包时会临时落盘，体积大概是产物本身的 1~2 倍。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PATTERNS = [
  { id: "hms-app-secret", re: /"appSecret"\s*:\s*"[0-9a-fA-F]{32,}"/ },
  { id: "client-secret", re: /"client_?secret"\s*:\s*"[^"\s]{8,}"/ },
  { id: "api-key", re: /"api_?key"\s*:\s*"[^"\s]{8,}"/ },
];

const MAX_DEPTH = 3;
const ARCHIVE = /\.(tar\.gz|tgz|tar\.zst)$/;
const HITS = [];

function record(label, id, sample) {
  const key = label + "#" + id;
  if (HITS.some((h) => h.key === key)) return;
  HITS.push({ key, label, id, sample: sample.replace(/\s+/g, " ").slice(0, 100) });
}

function scanBuffer(chunk, label, tail) {
  const text = tail + chunk.toString("latin1");
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) record(label, p.id, m[0]);
  }
  return text.slice(-4096);
}

function scanFile(file, label) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file);
    let tail = "";
    stream.on("data", (chunk) => (tail = scanBuffer(chunk, label, tail)));
    stream.on("end", resolve);
    stream.on("error", resolve);
  });
}

function extract(target, dir) {
  const flags = /\.tar\.zst$/.test(target) ? ["--zstd", "-xf", target, "-C", dir] : ["-xf", target, "-C", dir];
  const result = spawnSync("tar", flags, { encoding: "utf8" });
  if (result.status !== 0) {
    const reason = String(result.stderr || "").trim().split("\n").pop();
    console.error("  ! 解包失败，跳过：" + target + (reason ? "（" + reason + "）" : ""));
    return false;
  }
  return true;
}

function labelOf(target, origin, base) {
  if (!base || target === origin) return origin;
  return origin + " → " + path.relative(base, target);
}

async function walk(dir, ctx) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, ctx);
    else if (entry.isFile()) await scanTarget(full, ctx);
  }
}

async function scanTarget(target, ctx) {
  const { depth = 0, origin = target, base = null } = ctx || {};

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    console.error("  ! 跳过 " + target + "（不存在）");
    return;
  }

  if (stat.isDirectory()) return walk(target, { depth, origin, base: base || target });

  const label = labelOf(target, origin, base);
  if (!ARCHIVE.test(target)) return scanFile(target, label);

  if (depth >= MAX_DEPTH) {
    console.error("  ! 嵌套超过 " + MAX_DEPTH + " 层，停止展开：" + label);
    return;
  }

  // 先扫外层（未压缩的文本成员），再解开递归扫内层归档
  await scanFile(target, label);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mo-scan-"));
  try {
    if (extract(target, tmp)) {
      await walk(tmp, { depth: depth + 1, origin: label, base: tmp });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const enforce = args.includes("--enforce");
const targets = args.filter((a) => a !== "--enforce");

if (targets.length === 0) {
  console.error("用法：node scripts/check-artifacts.mjs [--enforce] <文件或目录>...");
  process.exit(2);
}

for (const target of targets) await scanTarget(target);

if (HITS.length === 0) {
  console.log("✓ 产物里未发现密钥：" + targets.join(", "));
  process.exit(0);
}

console.error("产物里有密钥字段：");
for (const h of HITS) console.error("  [" + h.id + "] " + h.label + "  " + h.sample);

if (enforce) {
  console.error("\n--enforce：发布产物不允许带密钥，构建失败。");
  process.exit(1);
}

console.error("\n注意：该产物含真实密钥，仅限本机自用，不要上传/分发。");
process.exit(0);
