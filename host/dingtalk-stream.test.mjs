import test from "node:test";
import assert from "node:assert/strict";
import { createDingTalkStream } from "./dingtalk-stream.mjs";

function fakeClient() {
  const callbacks = new Map();
  const acks = [];
  return {
    connected: false,
    registered: false,
    reconnecting: false,
    callbacks,
    acks,
    registerCallbackListener(topic, cb) { callbacks.set(topic, cb); return this; },
    async connect() { this.connected = true; },
    disconnect() { this.connected = false; this.registered = false; },
    socketCallBackResponse(id, result) { acks.push({ id, result }); },
  };
}

test("Stream：状态映射 + ACK + 消息回调", async () => {
  const client = fakeClient();
  const messages = [];
  const statuses = [];
  const stream = createDingTalkStream({
    client,
    onMessage: (frame) => messages.push(frame),
    onStatus: (status) => statuses.push(status),
  });

  await stream.start();
  assert.equal(stream.getStatus(), "connected");

  client.registered = true;
  assert.equal(stream.refresh(), "connected");

  const topic = [...client.callbacks.keys()][0];
  assert.equal(topic, "/v1.0/im/bot/messages/get");
  client.callbacks.get(topic)({ headers: { messageId: "m1" }, data: "{}" });
  assert.equal(messages.length, 1);

  stream.ack("m1", { status: "SUCCESS" });
  assert.deepEqual(client.acks[0], { id: "m1", result: { status: "SUCCESS" } });

  client.reconnecting = true;
  assert.equal(stream.refresh(), "reconnecting");

  stream.stop();
  assert.equal(stream.getStatus(), "stopped");
  assert.ok(statuses.includes("connected"));
});
