#!/usr/bin/env node
// 扫描构建产物，确认没有把 HMS App Secret / 第三方密钥打进去。
//
//   node scripts/check-artifacts.mjs desktop/runtime.tar.gz        # 只警告
//   node scripts/check-artifacts.mjs --enforce desktop/runtime.tar.gz
//
// 本地带密钥的包是允许的（SEC-001 的取舍），所以默认只报警；
// CI / 发布前必须加 --enforce，命中即失败。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PATTERNS = [
  { id: "hms-app-secret", re: /"appSecret"\s*:\s*"[0-9a-fA-F]{32,}"/ },
  { id: "client-secret", re: /"client_?secret"\s*:\s*"[^"\s]{8,}"/ },
  { id: "api-key", re: /"api_?key"\s*:\s*"[^"\s]{8,}"/ },
];

const HITS = [];

function record(label, id, sample) {
  if (HITS.some((h) => h.label === label && h.id === id)) return;
  HITS.push({ label, id, sample: sample.slice(0, 100) });
}

function scanStream(stream, label) {
  return new Promise((resolve) => {
    let tail = "";
    stream.on("data", (chunk) => {
      const text = tail + chunk.toString("latin1");
      for (const p of PATTERNS) {
        const m = text.match(p.re);
        if (m) record(label, p.id, m[0]);
      }
      tail = text.slice(-4096);
    });
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", resolve);
  });
}

function scanFile(file) {
  return scanStream(fs.createReadStream(file), file);
}

function scanArchive(file, flag) {
  return new Promise((resolve) => {
    const child = spawn("tar", [flag, "-xOf", file], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", () => {
      console.error("  ! 跳过 " + file + "（tar 不可用或不支持该格式）");
      resolve();
    });
    child.on("close", (code) => {
      if (code !== 0) console.error("  ! 解包 " + file + " 失败：" + stderr.trim().split("\n").slice(-1)[0]);
    });
    scanStream(child.stdout, file).then(resolve);
  });
}

async function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) await scanFile(full);
  }
}

async function scan(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    console.error("  ! 跳过 " + target + "（不存在）");
    return;
  }
  if (stat.isDirectory()) return walk(target);
  if (/\.tar\.gz$|\.tgz$/.test(target)) return scanArchive(target, "-z");
  if (/\.tar\.zst$/.test(target)) return scanArchive(target, "--zstd");
  return scanFile(target);
}

const args = process.argv.slice(2);
const enforce = args.includes("--enforce");
const targets = args.filter((a) => a !== "--enforce");

if (targets.length === 0) {
  console.error("用法：node scripts/check-artifacts.mjs [--enforce] <文件或目录>...");
  process.exit(2);
}

for (const target of targets) {
  await scan(target);
}

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
