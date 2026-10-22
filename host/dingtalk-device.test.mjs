import test from "node:test";
import assert from "node:assert/strict";
import { beginRegistration, waitForCredentials } from "./dingtalk-device.mjs";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    const handler = routes[path];
    if (!handler) throw new Error("unexpected " + path);
    return handler(init);
  };
  impl.calls = calls;
  return impl;
}

test("device-code：init/begin 返回二维码地址并追加 source", async () => {
  const fetchImpl = fakeFetch({
    "/app/registration/init": () => jsonResponse({ errcode: 0, nonce: "n-1" }),
    "/app/registration/begin": () => jsonResponse({
      errcode: 0,
      device_code: "dc-1",
      verification_uri_complete: "https://open-dev.dingtalk.com/openapp/registration/openClaw?x=1",
      expires_in: 600,
      interval: 2,
    }),
  });

  const begin = await beginRegistration({ fetchImpl, source: "MO_AGENT", baseUrl: "https://example.test" });
  assert.equal(begin.deviceCode, "dc-1");
  assert.equal(begin.expiresInSeconds, 600);
  assert.equal(begin.intervalSeconds, 2);
  assert.equal(begin.verificationUriComplete, "https://open-dev.dingtalk.com/openapp/registration/openClaw?x=1");
  assert.equal(fetchImpl.calls.length, 2);
});

test("device-code：WAITING 后 SUCCESS 返回 clientId/clientSecret", async () => {
  let poll = 0;
  const fetchImpl = fakeFetch({
    "/app/registration/poll": () => {
      poll += 1;
      return jsonResponse(poll === 1
        ? { errcode: 0, status: "WAITING" }
        : { errcode: 0, status: "SUCCESS", client_id: "ding-id", client_secret: "secret" });
    },
  });

  const result = await waitForCredentials(
    { deviceCode: "dc", expiresInSeconds: 60, intervalSeconds: 1 },
    { fetchImpl, baseUrl: "https://example.test", sleep: async () => {}, now: () => 0 },
  );
  assert.equal(result.clientId, "ding-id");
  assert.equal(result.clientSecret, "secret");
  assert.equal(poll, 2);
});

test("device-code：SCANNED/CREATING/APPROVING 都是中间态，凭据下发即成功", async () => {
  let poll = 0;
  const statuses = ["SCANNED", "CREATING", "PUBLISHING", "APPROVING"];
  const fetchImpl = fakeFetch({
    "/app/registration/poll": () => {
      const status = statuses[Math.min(poll, statuses.length - 1)];
      poll += 1;
      if (status === "APPROVING") {
        return jsonResponse({
          errcode: 0,
          status,
          client_id: "id-approving",
          client_secret: "sec-approving",
          robot_code: "robot-1",
          mode: "STREAM",
        });
      }
      return jsonResponse({ errcode: 0, status });
    },
  });

  const result = await waitForCredentials(
    { deviceCode: "dc", expiresInSeconds: 60, intervalSeconds: 1 },
    { fetchImpl, baseUrl: "https://example.test", sleep: async () => {}, now: () => 0 },
  );
  assert.equal(result.clientId, "id-approving");
  assert.equal(result.clientSecret, "sec-approving");
  assert.equal(result.robotCode, "robot-1");
  assert.equal(result.status, "APPROVING");
  assert.equal(poll, 4);
});
test("device-code：FAIL / EXPIRED 抛错", async () => {
  const failFetch = fakeFetch({
    "/app/registration/poll": () => jsonResponse({ errcode: 0, status: "FAIL", fail_reason: "denied" }),
  });
  await assert.rejects(
    () => waitForCredentials(
      { deviceCode: "dc", expiresInSeconds: 60, intervalSeconds: 1 },
      { fetchImpl: failFetch, baseUrl: "https://example.test", sleep: async () => {}, now: () => 0 },
    ),
    /authorization failed: denied/,
  );

  const expiredFetch = fakeFetch({
    "/app/registration/poll": () => jsonResponse({ errcode: 0, status: "EXPIRED" }),
  });
  await assert.rejects(
    () => waitForCredentials(
      { deviceCode: "dc", expiresInSeconds: 60, intervalSeconds: 1 },
      { fetchImpl: expiredFetch, baseUrl: "https://example.test", sleep: async () => {}, now: () => 0 },
    ),
    /expired/,
  );
});

test("device-code：轮询网络抖动后继续，最终成功", async () => {
  let poll = 0;
  const fetchImpl = fakeFetch({
    "/app/registration/poll": () => {
      poll += 1;
      if (poll === 1) throw new Error("network");
      return jsonResponse({ errcode: 0, status: "SUCCESS", client_id: "id", client_secret: "sec" });
    },
  });

  const result = await waitForCredentials(
    { deviceCode: "dc", expiresInSeconds: 60, intervalSeconds: 1 },
    { fetchImpl, baseUrl: "https://example.test", sleep: async () => {}, now: () => 0 },
  );
  assert.equal(result.clientId, "id");
  assert.equal(poll, 2);
});
