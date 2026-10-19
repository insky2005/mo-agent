import test from "node:test";
import assert from "node:assert/strict";
import { formatSseEvent, isLoopbackAddress } from "./http.mjs";

const event = {
  seq: 7,
  at: 1,
  type: "session.upsert",
  payload: { sessionId: "s1", status: "working" },
};

function dataOf(frame) {
  const line = frame.split("\n").find((item) => item.startsWith("data: "));
  return JSON.parse(line.slice(6));
}

test("配置管理只放行本机地址", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.0.1.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("localhost"), true);
  assert.equal(isLoopbackAddress("192.168.1.20"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.20"), false);
  assert.equal(isLoopbackAddress(""), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("M4：SSE 只发统一 message 信封", () => {
  const frame = formatSseEvent(event);
  assert.match(frame, /^id: 7\n/);
  assert.match(frame, /\nevent: message\n/);
  assert.deepEqual(dataOf(frame), event);
});
