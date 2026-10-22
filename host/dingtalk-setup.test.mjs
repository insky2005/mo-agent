import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDingTalkSetup } from "./dingtalk-setup.mjs";

function jsonResponse(body) {
  return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
}

function fakeFetch() {
  return async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/init")) return jsonResponse({ errcode: 0, nonce: "n1" });
    if (pathname.endsWith("/begin")) return jsonResponse({
      errcode: 0,
      device_code: "dc1",
      verification_uri_complete: "https://open-dev.example/registration?x=1",
      expires_in: 60,
      interval: 1,
    });
    if (pathname.endsWith("/poll")) return jsonResponse({ errcode: 0, status: "SUCCESS", client_id: "cid", client_secret: "sec" });
    return jsonResponse({ errcode: 0 });
  };
}

test("setup：扫码成功后写入 notify.json 并回调", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-dt-setup-"));
  const notifyFile = path.join(dir, "notify.json");
  fs.writeFileSync(notifyFile, JSON.stringify({ channels: [{ type: "bark", url: "https://bark" }] }));

  let provisioned = null;
  const setup = createDingTalkSetup({
    notifyFile,
    fetchImpl: fakeFetch(),
    sleep: async () => {},
    onProvisioned: async (creds) => { provisioned = creds; },
  });

  const started = await setup.start();
  assert.equal(started.state, "polling");
  assert.match(started.verificationUriComplete, /source=MO_AGENT/);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = setup.status();
  assert.equal(status.state, "done");
  assert.equal(provisioned.clientId, "cid");
  assert.equal(provisioned.clientSecret, "sec");

  const saved = JSON.parse(fs.readFileSync(notifyFile, "utf8"));
  assert.equal(saved.channels.length, 2);
  const dt = saved.channels.find((item) => item.type === "dingtalk-bot");
  assert.equal(dt.clientId, "cid");
  assert.equal(dt.clientSecret, "sec");
});

test("setup：cancel 后忽略迟到结果", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-dt-setup-"));
  const setup = createDingTalkSetup({
    notifyFile: path.join(dir, "notify.json"),
    fetchImpl: fakeFetch(),
    sleep: async () => { await new Promise((r) => setTimeout(r, 30)); },
    onProvisioned: () => { throw new Error("should not provision"); },
  });
  await setup.start();
  setup.cancel();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(setup.status().state, "idle");
  assert.equal(fs.existsSync(path.join(dir, "notify.json")), false);
});
