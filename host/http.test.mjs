import test from "node:test";
import assert from "node:assert/strict";
import { formatSseEvent } from "./http.mjs";

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

test("旧客户端：named event 保持兼容", () => {
  const frame = formatSseEvent(event, false);
  assert.match(frame, /^id: 7\n/);
  assert.match(frame, /\nevent: session\.upsert\n/);
  assert.deepEqual(dataOf(frame), event);
});

test("新客户端：统一 message 信封", () => {
  const frame = formatSseEvent(event, true);
  assert.match(frame, /^id: 7\n/);
  assert.match(frame, /\nevent: message\n/);
  assert.deepEqual(dataOf(frame), event);
});
