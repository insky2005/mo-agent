import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHelperClient } from "./helper-client.mjs";

test("helper client：selftest / record / quit 走本地 socket", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mo-helper-"));
  const infoPath = path.join(dir, "info.json");
  const token = "test-token";
  const received = [];

  const server = net.createServer(function (socket) {
    let buffer = "";
    socket.on("data", function (chunk) {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      const message = JSON.parse(buffer.slice(0, index));
      received.push(message);
      let reply;
      if (message.cmd === "ping") reply = { ok: true };
      else if (message.cmd === "selftest") reply = { ok: true, micAuthorization: "AVAuthorizationStatus(rawValue: 3)" };
      else if (message.cmd === "record") reply = { ok: true, file: "/tmp/x.wav", seconds: 1.2 };
      else if (message.cmd === "quit") reply = { ok: true };
      else reply = { ok: false, error: "unknown" };
      socket.end(JSON.stringify(reply) + "\n");
    });
  });

  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await fs.writeFile(infoPath, JSON.stringify({ pid: process.pid, port, token }));

  try {
    const client = createHelperClient({
      infoPath,
      app: "/fake.app/Contents/MacOS/mo-voice-bridge",
      log: function () {},
    });

    const selftest = await client.selftest();
    assert.equal(selftest.ok, true);
    assert.equal(selftest.micAuthorization, "AVAuthorizationStatus(rawValue: 3)");

    const record = await client.record({ timeoutMs: 1000 });
    assert.equal(record.ok, true);
    assert.equal(record.file, "/tmp/x.wav");

    await client.shutdown();
    const recordMessage = received.find(function (message) { return message.cmd === "record"; });
    assert.ok(recordMessage);
    assert.equal(recordMessage.token, token);
    assert.equal(recordMessage.timeout, 1);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
