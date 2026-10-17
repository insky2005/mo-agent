import test from "node:test";
import assert from "node:assert/strict";
import { createHmsChannel } from "./hms-push.mjs";

const log = { warn() {}, info() {} };

function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error("unexpected fetch " + url);
    return next;
  };
  return { impl, calls };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("HMS：先换 token，再按 token 数组发送通知", async () => {
  const { impl, calls } = fakeFetch([
    jsonResponse(200, { access_token: "AT", expires_in: 3600 }),
    jsonResponse(200, { code: "80000000" }),
  ]);
  const channel = createHmsChannel({ appId: "119386705", appSecret: "SEC" }, {
    fetchImpl: impl,
    log,
    getTokens: () => ["tok1", "tok2"],
  });
  await channel.send({ title: "需要授权", body: "Bash" });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /oauth-login\.cloud\.huawei\.com/);
  assert.equal(calls[0].init.body, "grant_type=client_credentials&client_id=119386705&client_secret=SEC");
  assert.match(calls[1].url, /push-api\.cloud\.huawei\.com\/v1\/119386705\/messages:send/);
  assert.equal(calls[1].init.headers.authorization, "Bearer AT");
  const payload = JSON.parse(calls[1].init.body);
  assert.deepEqual(payload.message.token, ["tok1", "tok2"]);
  assert.equal(payload.message.notification.title, "需要授权");
  assert.equal(payload.message.android.notification.category, "WORK");
});

test("HMS：没有 token 时跳过、不请求", async () => {
  const { impl, calls } = fakeFetch([]);
  const channel = createHmsChannel({ appId: "1", appSecret: "x" }, { fetchImpl: impl, log, getTokens: () => [] });
  await channel.send({ title: "t", body: "b" });
  assert.equal(calls.length, 0);
});

test("HMS：返回码非成功时抛错", async () => {
  const { impl } = fakeFetch([
    jsonResponse(200, { access_token: "AT", expires_in: 3600 }),
    jsonResponse(200, { code: "80300007", msg: "bad token" }),
  ]);
  const channel = createHmsChannel({ appId: "1", appSecret: "x" }, { fetchImpl: impl, log, getTokens: () => ["t"] });
  await assert.rejects(() => channel.send({ title: "t" }), /HMS 推送失败/);
});

test("HMS：401 时刷新 token 重试", async () => {
  const { impl, calls } = fakeFetch([
    jsonResponse(200, { access_token: "AT1", expires_in: 3600 }),
    jsonResponse(401, {}),
    jsonResponse(200, { access_token: "AT2", expires_in: 3600 }),
    jsonResponse(200, { code: "80000000" }),
  ]);
  const channel = createHmsChannel({ appId: "1", appSecret: "x" }, { fetchImpl: impl, log, getTokens: () => ["t"] });
  await channel.send({ title: "t" });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].init.headers.authorization, "Bearer AT2");
});
