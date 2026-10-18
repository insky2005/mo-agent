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

test("M4：SSE 只发统一 message 信封", () => {
  const frame = formatSseEvent(event);
  assert.match(frame, /^id: 7\n/);
  assert.match(frame, /\nevent: message\n/);
  assert.deepEqual(dataOf(frame), event);
});
