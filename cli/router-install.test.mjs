import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installRuntime, listRuntimes, loadManifest, manifestFor, pruneRuntimes, runtimeBinPath, writeShim } from "./lib/router-install.mjs";
import { RUNTIMES } from "./lib/router-runtimes.mjs";
import { runtimeRoot } from "./lib/router-paths.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-router-inst-"));
}

function fakeInstall(home, version) {
  const dir = path.join(runtimeRoot({ home, env: {}, platform: process.platform }), "routers", "pi", version);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(runtimeBinPath(dir), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

test("清单来自模块，不读文件（单文件二进制里没有 runtimes.json）", () => {
  assert.equal(loadManifest(), RUNTIMES);
  assert.ok(Object.isFrozen(RUNTIMES));
  // 回归护栏：router 目录里任何文件都不该再引用 runtimes.json
  const dir = path.dirname(new URL(import.meta.url).pathname);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".mjs")) continue;
    if (name.endsWith(".test.mjs")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      // 注释里提一句是允许的；真正去读文件才拦
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
      assert.ok(!line.includes("runtimes.json"), name + " 又去读 runtimes.json 了（打包后会 ENOENT）");
    }
  }
});

test("清单里 pin 了版本与 Node 下限", () => {
  const manifest = loadManifest();
  assert.ok(manifest.pi);
  assert.equal(manifest.pi.version, "1.3.0");
  assert.equal(manifest.pi.package, "@earendil-works/pi-coding-agent");
  assert.match(manifest.pi.engines.node, /^>=/);
  assert.equal(manifestFor("pi").version, "1.3.0");
  assert.throws(() => manifestFor("nope"), (error) => error.code === "E_ROUTER_RUNTIME_MISSING");
});

test("列出与清理：只留指定版本", () => {
  const home = tempHome();
  fakeInstall(home, "1.2.0");
  fakeInstall(home, "1.3.0");

  const listed = listRuntimes({ home, env: {}, platform: process.platform });
  assert.deepEqual(listed.runtimes.map((item) => item.version).sort(), ["1.2.0", "1.3.0"]);
  assert.ok(listed.runtimes.every((item) => item.installed));

  const pruned = pruneRuntimes({ home, env: {}, platform: process.platform, keep: ["1.3.0"] });
  assert.deepEqual(pruned.removed, ["1.2.0"]);
  assert.deepEqual(listRuntimes({ home, env: {}, platform: process.platform }).runtimes.map((item) => item.version), ["1.3.0"]);
});

test("shim 把运行时钉到指定 Node 上", () => {
  const home = tempHome();
  const dir = fakeInstall(home, "1.3.0");
  const shim = writeShim(dir, "/usr/bin/env-node", "/x/cli.js");
  const text = fs.readFileSync(shim, "utf8");
  assert.ok(text.startsWith("#!/bin/sh"));
  assert.ok(text.includes('exec "/usr/bin/env-node" "/x/cli.js" "$@"'));
  assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
});

test("复用已装运行时：把裸 node 的 shim 修成绝对路径", async () => {
  const home = tempHome();
  const dir = fakeInstall(home, "1.3.0");
  const manifest = manifestFor("pi");
  const cli = path.join(dir, "node_modules", manifest.package, manifest.bin);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "// cli\n");
  // 模拟旧版本装出来的坏 shim
  fs.writeFileSync(path.join(dir, "bin", "pi"), '#!/bin/sh\nexec "node" "' + cli + '" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "install.json"), JSON.stringify({ v: 1, node: "node", cli }));

  const result = await installRuntime({ home, env: {}, platform: process.platform });
  assert.equal(result.reused, true);
  assert.equal(result.repaired, true);
  const shim = fs.readFileSync(path.join(dir, "bin", "pi"), "utf8");
  assert.ok(!shim.includes('exec "node"'), "shim 还被钉在裸 node 上");
  assert.ok(shim.includes(path.isAbsolute(result.node) ? result.node : "x"));
  const record = JSON.parse(fs.readFileSync(path.join(dir, "install.json"), "utf8"));
  assert.ok(path.isAbsolute(record.node), "install.json 里的 node 应该是绝对路径");
});

test("空目录不报错，返回空清单", () => {
  const home = tempHome();
  const listed = listRuntimes({ home, env: {}, platform: process.platform });
  assert.deepEqual(listed.runtimes, []);
});
