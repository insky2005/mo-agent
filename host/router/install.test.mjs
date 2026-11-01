import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRuntimes, loadManifest, manifestFor, pruneRuntimes, runtimeBinPath, writeShim } from "./install.mjs";
import { runtimeRoot } from "./paths.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-router-inst-"));
}

function fakeInstall(home, version) {
  const dir = path.join(runtimeRoot({ home, env: {}, platform: process.platform }), "routers", "pi", version);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(runtimeBinPath(dir), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

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

test("空目录不报错，返回空清单", () => {
  const home = tempHome();
  const listed = listRuntimes({ home, env: {}, platform: process.platform });
  assert.deepEqual(listed.runtimes, []);
});
