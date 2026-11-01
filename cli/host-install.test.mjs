import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostBinary, hostRuntimeDir, pickRuntimeAsset, runtimeAssetName } from "./lib/host-install.mjs";

test("host 运行时落在 findHost 预留的位置", () => {
  assert.equal(hostRuntimeDir("/Users/x"), "/Users/x/.mo-agent/runtime");
  assert.equal(hostBinary("/Users/x"), "/Users/x/.mo-agent/runtime/bin/mo-agent-host");
});

test("资产名按平台与架构约定", () => {
  assert.equal(runtimeAssetName({ platform: "darwin", arch: "arm64" }), "mo-agent-runtime-darwin-arm64.tar.gz");
  assert.equal(runtimeAssetName({ platform: "darwin", arch: "x64" }), "mo-agent-runtime-darwin-x64.tar.gz");
  assert.equal(runtimeAssetName({ platform: "linux", arch: "arm64" }), "mo-agent-runtime-linux-arm64.tar.gz");
  assert.equal(runtimeAssetName({ platform: "win32", arch: "x64" }), "mo-agent-runtime-win32-x64.zip");
});

test("从 release 里挑资产，并带上 sha256", () => {
  const releases = [
    { tag_name: "cli-v0.3.0", assets: [{ name: "mo-darwin-arm64", browser_download_url: "u1" }] },
    {
      tag_name: "desktop-v0.3.0",
      assets: [
        { name: "mo-agent-runtime-darwin-arm64.tar.gz", browser_download_url: "u2" },
        { name: "mo-agent-runtime-darwin-arm64.tar.gz.sha256", browser_download_url: "u3" },
      ],
    },
  ];
  const picked = pickRuntimeAsset(releases, "mo-agent-runtime-darwin-arm64.tar.gz");
  assert.equal(picked.asset.browser_download_url, "u2");
  assert.equal(picked.sha.browser_download_url, "u3");
  assert.equal(picked.tag, "desktop-v0.3.0");
  assert.equal(pickRuntimeAsset(releases, "nope.tar.gz"), null);
});
