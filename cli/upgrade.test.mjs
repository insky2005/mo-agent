import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assetName,
  parseVersion,
  compareVersions,
  normalizeTag,
  pickRelease,
  detectInstall,
  verifyChecksum,
  installBinary,
  runUpgrade,
  readCheckCache,
  writeCheckCache,
  cachedUpdate,
} from "./lib/upgrade.mjs";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));
const ASSET = "mo-darwin-arm64";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-upgrade-"));
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

const script = (version) => "#!/bin/sh\necho " + version + "\n";

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
}

function textResponse(value) {
  return { ok: true, status: 200, text: async () => value };
}

function bytesResponse(buffer) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function release(tag, options = {}) {
  const asset = options.asset || ASSET;
  const assets = [{ name: asset, browser_download_url: "https://example.test/" + tag + "/" + asset }];
  if (options.withSha !== false) {
    assets.push({ name: asset + ".sha256", browser_download_url: "https://example.test/" + tag + "/" + asset + ".sha256" });
  }
  return { tag_name: tag, assets };
}

/** 假 fetch：按 URL 分流；requests 记录调用顺序，便于断言"没下载" */
function makeFetch({ releases = [], binary = Buffer.alloc(0), checksum = "" } = {}) {
  const requests = [];
  const fetch = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target.includes("/releases?")) return jsonResponse(releases);
    if (target.endsWith(".sha256")) return textResponse(checksum);
    if (target.endsWith("/" + ASSET)) return bytesResponse(binary);
    return { ok: false, status: 404 };
  };
  return { fetch, requests };
}

function binaryInstall(dir) {
  const target = path.join(dir, "bin", "mo");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

test("版本解析与比较", () => {
  assert.equal(parseVersion("cli-v0.3.0").raw, "cli-v0.3.0");
  assert.equal(parseVersion("0.3.0").major, 0);
  assert.equal(parseVersion("apk-v0.2.0"), null);
  assert.equal(parseVersion("nope"), null);
  assert.equal(compareVersions("0.2.0", "0.3.0"), -1);
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("cli-v0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.3.0", "0.3.0-rc.1"), 1);
  assert.equal(compareVersions("0.3.0-rc.1", "0.3.0-rc.2"), -1);
  assert.equal(normalizeTag("0.4.0"), "cli-v0.4.0");
  assert.equal(normalizeTag("v0.4.0"), "cli-v0.4.0");
  assert.equal(normalizeTag("cli-v0.4.0"), "cli-v0.4.0");
  assert.throws(() => normalizeTag("apk-v1.0.0"), (error) => error.code === "E_UPGRADE_VERSION");
  assert.throws(() => normalizeTag(""), (error) => error.code === "E_USAGE");
});

test("资产命名按平台映射，不支持的平台明确报错", () => {
  assert.equal(assetName("darwin", "arm64"), "mo-darwin-arm64");
  assert.equal(assetName("darwin", "x64"), "mo-darwin-x64");
  assert.equal(assetName("linux", "arm64"), "mo-linux-arm64");
  assert.equal(assetName("win32", "x64"), "mo-windows-x64.exe");
  assert.throws(() => assetName("aix", "ppc64"), (error) => error.code === "E_UPGRADE_UNSUPPORTED");
});

test("挑 Release：只认 cli-v*、带本平台资产、版本最高", () => {
  const releases = [
    release("apk-v9.9.9", { asset: "mo-agent-android-9.9.9.apk" }),
    release("desktop-v9.9.9", { asset: "mo-agent-desktop-9.9.9-macos-arm64.zip" }),
    release("cli-v0.2.1"),
    release("cli-v0.3.0"),
    release("cli-v0.9.9", { asset: "mo-linux-x64" }),
  ];
  const picked = pickRelease(releases, ASSET);
  assert.equal(picked.tag, "cli-v0.3.0");
  assert.equal(picked.version.raw, "cli-v0.3.0");
  assert.ok(picked.asset.browser_download_url.endsWith("/mo-darwin-arm64"));
  assert.ok(picked.sha256);
  assert.equal(pickRelease([], ASSET), null);
  assert.equal(pickRelease([release("cli-v0.3.0", { withSha: false })], ASSET).sha256, null);
});

test("识别安装方式：二进制 / 源码 / npm 全局", () => {
  assert.equal(detectInstall({ execPath: "/Users/a/.local/bin/mo", bun: true, argv: ["mo"] }).mode, "binary");
  assert.equal(detectInstall({ execPath: "/usr/local/bin/node", bun: false, argv: ["node", "/repo/cli/mo.mjs"] }).mode, "source");
  assert.equal(
    detectInstall({ execPath: "/usr/local/bin/node", bun: false, argv: ["node", "/repo/node_modules/mo-agent/cli/mo.mjs"] }).mode,
    "npm",
  );
  assert.equal(detectInstall({ execPath: "/opt/homebrew/bin/bun", bun: true, argv: ["bun", "/repo/cli/mo.mjs"] }).mode, "source");
});

test("校验和不匹配就报错，不落盘", () => {
  const bytes = Buffer.from(script("0.9.0"));
  assert.equal(verifyChecksum(bytes, sha(bytes) + "  " + ASSET), sha(bytes));
  assert.throws(() => verifyChecksum(bytes, "0".repeat(64)), (error) => error.code === "E_UPGRADE_CHECKSUM");
  assert.throws(() => verifyChecksum(bytes, "not-a-digest"), (error) => error.code === "E_UPGRADE_CHECKSUM");
});

test("已是最新：不下载、不替换，只写检测缓存", async () => {
  const home = tempDir();
  const target = binaryInstall(home);
  const original = script("0.9.0");
  fs.writeFileSync(target, original, { mode: 0o755 });

  const { fetch, requests } = makeFetch({ releases: [release("cli-v0.9.0")] });
  const result = await runUpgrade({
    current: "0.9.0",
    home,
    install: { mode: "binary", path: target },
    platform: "darwin",
    arch: "arm64",
    fetch,
    verifyRun: false,
  });

  assert.equal(result.skipped, "up-to-date");
  assert.equal(result.installed, false);
  assert.equal(result.updateAvailable, false);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(requests.length, 1);
  assert.equal(readCheckCache(home).latest, "0.9.0");
});

test("有新版：下载、校验、原子替换，保留 0755", async () => {
  const home = tempDir();
  const target = binaryInstall(home);
  fs.writeFileSync(target, script("0.9.0"), { mode: 0o755 });

  const bytes = Buffer.from(script("1.0.0"));
  const { fetch, requests } = makeFetch({ releases: [release("cli-v1.0.0")], binary: bytes, checksum: sha(bytes) + "  " + ASSET });
  const result = await runUpgrade({
    current: "0.9.0",
    home,
    install: { mode: "binary", path: target },
    platform: "darwin",
    arch: "arm64",
    fetch,
    verifyRun: false,
  });

  assert.equal(result.installed, true);
  assert.equal(result.latest, "1.0.0");
  assert.equal(result.tag, "cli-v1.0.0");
  assert.equal(fs.readFileSync(target, "utf8"), bytes.toString());
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(readCheckCache(home).current, "1.0.0");
  assert.equal(requests.filter((url) => url.includes("/releases?")).length, 1);
});

test("校验失败：退出前原文件一个字节都不动", async () => {
  const home = tempDir();
  const target = binaryInstall(home);
  const original = script("0.9.0");
  fs.writeFileSync(target, original, { mode: 0o755 });

  const bytes = Buffer.from(script("1.0.0"));
  const { fetch } = makeFetch({ releases: [release("cli-v1.0.0")], binary: bytes, checksum: "0".repeat(64) });
  await assert.rejects(
    runUpgrade({
      current: "0.9.0",
      home,
      install: { mode: "binary", path: target },
      platform: "darwin",
      arch: "arm64",
      fetch,
      verifyRun: false,
    }),
    (error) => error.code === "E_UPGRADE_CHECKSUM",
  );
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("源码 / npm 全局运行：拒绝自替换并给出做法", async () => {
  const home = tempDir();
  const { fetch } = makeFetch({ releases: [release("cli-v1.0.0")] });
  for (const mode of ["source", "npm"]) {
    await assert.rejects(
      runUpgrade({
        current: "0.9.0",
        home,
        install: { mode, path: mode === "npm" ? "/repo/node_modules/mo-agent/cli/mo.mjs" : "/repo/cli/mo.mjs" },
        platform: "darwin",
        arch: "arm64",
        fetch,
      }),
      (error) => error.code === "E_UPGRADE_SOURCE" && Boolean(error.details && error.details.hint),
    );
  }
});

test("--dry-run 只打印计划，不碰网络下载", async () => {
  const home = tempDir();
  const target = binaryInstall(home);
  const original = script("0.9.0");
  fs.writeFileSync(target, original, { mode: 0o755 });

  const bytes = Buffer.from(script("1.0.0"));
  const { fetch, requests } = makeFetch({ releases: [release("cli-v1.0.0")], binary: bytes, checksum: sha(bytes) });
  const result = await runUpgrade({
    current: "0.9.0",
    dryRun: true,
    home,
    install: { mode: "binary", path: target },
    platform: "darwin",
    arch: "arm64",
    fetch,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.wouldInstall, true);
  assert.equal(result.installed, false);
  assert.equal(requests.some((url) => url.endsWith(".sha256")), false);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("显式版本：直接按 tag 拼地址，不查 Release 列表", async () => {
  const home = tempDir();
  const target = binaryInstall(home);
  fs.writeFileSync(target, script("0.9.0"), { mode: 0o755 });

  const bytes = Buffer.from(script("1.1.0"));
  const { fetch, requests } = makeFetch({ binary: bytes, checksum: sha(bytes) });
  const result = await runUpgrade({
    current: "0.9.0",
    version: "1.1.0",
    home,
    install: { mode: "binary", path: target },
    platform: "darwin",
    arch: "arm64",
    fetch,
    verifyRun: false,
  });

  assert.equal(result.tag, "cli-v1.1.0");
  assert.equal(result.installed, true);
  assert.equal(requests.some((url) => url.includes("/releases?")), false);
  assert.equal(requests.length, 2);
});

test("降级：不加 --force 拒绝，加了才允许", async () => {
  const home = tempDir();
  const target = binaryInstall(home);
  fs.writeFileSync(target, script("2.0.0"), { mode: 0o755 });

  const bytes = Buffer.from(script("1.0.0"));
  const { fetch } = makeFetch({ binary: bytes, checksum: sha(bytes) });
  await assert.rejects(
    runUpgrade({
      current: "2.0.0",
      version: "1.0.0",
      home,
      install: { mode: "binary", path: target },
      platform: "darwin",
      arch: "arm64",
      fetch,
      verifyRun: false,
    }),
    (error) => error.code === "E_UPGRADE_DOWNGRADE",
  );

  const forced = await runUpgrade({
    current: "2.0.0",
    version: "1.0.0",
    force: true,
    home,
    install: { mode: "binary", path: target },
    platform: "darwin",
    arch: "arm64",
    fetch,
    verifyRun: false,
  });
  assert.equal(forced.installed, true);
});

test("替换前先跑 --version；版本不符就不替换", { skip: process.platform === "win32" }, async () => {
  const home = tempDir();
  const target = binaryInstall(home);
  const original = script("0.9.0");
  fs.writeFileSync(target, original, { mode: 0o755 });

  const good = Buffer.from(script("1.0.0"));
  const { fetch } = makeFetch({ binary: good, checksum: sha(good) });
  const result = await runUpgrade({
    current: "0.9.0",
    version: "1.0.0",
    home,
    install: { mode: "binary", path: target },
    platform: "darwin",
    arch: "arm64",
    fetch,
  });
  assert.equal(result.installed, true);

  const bad = Buffer.from(script("0.5.0"));
  const { fetch: badFetch } = makeFetch({ binary: bad, checksum: sha(bad) });
  await assert.rejects(
    runUpgrade({
      current: "1.0.0",
      version: "1.1.0",
      home,
      install: { mode: "binary", path: target },
      platform: "darwin",
      arch: "arm64",
      fetch: badFetch,
    }),
    (error) => error.code === "E_UPGRADE_VERIFY",
  );
  assert.equal(fs.readFileSync(target, "utf8"), good.toString());
});

test("installBinary 目标目录不存在时会建出来", () => {
  const home = tempDir();
  const target = path.join(home, "deep", "bin", "mo");
  const bytes = Buffer.from(script("3.0.0"));
  installBinary({ bytes, target, verifyRun: false });
  assert.equal(fs.readFileSync(target, "utf8"), bytes.toString());
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
});

test("检测缓存：比当前新才提示，mo doctor 不联网", () => {
  const home = tempDir();
  assert.equal(cachedUpdate(home, "0.9.0"), null);
  writeCheckCache(home, { checkedAt: "2026-01-01T00:00:00.000Z", current: "0.9.0", latest: "1.0.0", tag: "cli-v1.0.0" });
  assert.equal(cachedUpdate(home, "0.9.0").latest, "1.0.0");
  assert.equal(cachedUpdate(home, "1.0.0"), null);
  fs.writeFileSync(path.join(home, "upgrade-check.json"), "{broken");
  assert.equal(cachedUpdate(home, "0.9.0"), null);
});

test("mo help upgrade 列出全部选项", () => {
  const home = tempDir();
  const result = spawnSync(process.execPath, [MO, "help", "upgrade"], {
    encoding: "utf8",
    env: { ...process.env, MO_AGENT_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mo upgrade —— 升级/);
  for (const flag of ["--check", "--dry-run", "--version", "--force", "--json"]) {
    assert.match(result.stdout, new RegExp(flag.replace("-", "\\-")));
  }
});
