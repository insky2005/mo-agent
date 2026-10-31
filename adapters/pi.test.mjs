import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../core/hub.mjs";
import { EVENT } from "../core/events.mjs";
import { PiAdapter } from "./pi.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-pi-"));
  const project = path.join(root, "--tmp-project--");
  fs.mkdirSync(project);
  return { root, project };
}

function line(entry) {
  return JSON.stringify(entry) + "\n";
}

function header(id, cwd) {
  return { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd };
}

let seq = 0;
function message(role, content, options) {
  const opts = options || {};
  seq += 1;
  const entry = {
    type: "message",
    id: "e" + seq,
    parentId: opts.parentId === undefined ? null : opts.parentId,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content,
      timestamp: Date.now(),
    },
  };
  if (role === "assistant") entry.message.stopReason = opts.stopReason || "stop";
  if (role === "toolResult") entry.message.toolCallId = opts.toolCallId || "c1";
  return entry;
}

function makeAdapter(root) {
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  const adapter = new PiAdapter({ hub, log: quiet, profile: { session: { root } } });
  return { hub, events, adapter };
}

test("Pi 适配器：观测一轮完整对话，并在下一轮结束时发完成事件", () => {
  const { root, project } = setup();
  const sessionId = "sess-pi-1";
  const file = path.join(project, "2026-10-25T00-00-00-000Z_" + sessionId + ".jsonl");
  const user1 = message("user", "第一个问题");
  const assistant1 = message("assistant", [{ type: "text", text: "先看一下" }], {
    stopReason: "toolUse",
    parentId: user1.id,
  });
  const tool1 = message("toolResult", [{ type: "text", text: "ok" }], { parentId: assistant1.id });
  const assistant2 = message("assistant", [{ type: "text", text: "第一轮回答" }], {
    stopReason: "stop",
    parentId: tool1.id,
  });

  fs.writeFileSync(
    file,
    line(header(sessionId, "/tmp/project")) +
      line(user1) + line(assistant1) + line(tool1) + line(assistant2)
  );

  const { hub, events, adapter } = makeAdapter(root);
  adapter.tick();

  let upserts = events.filter((event) => event.type === EVENT.SESSION_UPSERT);
  assert.ok(upserts.length >= 1);
  let record = upserts[upserts.length - 1].payload;
  assert.equal(record.sessionId, "pi:" + sessionId);
  assert.equal(record.agent, "pi");
  assert.equal(record.agentLabel, "Pi");
  assert.equal(record.cwd, "/tmp/project");
  assert.equal(record.lastPrompt, "第一个问题");
  assert.equal(record.lastResponse, "第一轮回答");
  assert.equal(record.turns, 1);
  assert.equal(record.status, "completed");
  assert.deepEqual(record.capabilities.control, [], "没有控制扩展时只读");
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0, "首次扫描不补发历史完成");

  events.length = 0;
  const user2 = message("user", "第二个问题", { parentId: assistant2.id });
  const assistant3 = message("assistant", [{ type: "text", text: "第二轮回答" }], {
    stopReason: "stop",
    parentId: user2.id,
  });
  fs.appendFileSync(file, line(user2) + line(assistant3));
  adapter.tick();

  assert.equal(events.filter((event) => event.type === EVENT.RUN_STARTED).length, 1);
  const done = events.find((event) => event.type === EVENT.RUN_COMPLETED);
  assert.ok(done);
  assert.equal(done.payload.sessionId, "pi:" + sessionId);
  assert.equal(done.payload.text, "第二轮回答");
  record = hub.get("pi:" + sessionId);
  assert.equal(record.turns, 2);
  assert.equal(record.lastPrompt, "第二个问题");
  assert.equal(record.title, "第一个问题", "会话名保持第一问");

  fs.unlinkSync(file);
  events.length = 0;
  adapter.tick();
  assert.ok(events.find((event) => event.type === EVENT.SESSION_REMOVED));
});

test("Pi 适配器：assistant error 发 run.failed", () => {
  const { root, project } = setup();
  const sessionId = "sess-pi-fail";
  const file = path.join(project, "2026-10-25T01-00-00-000Z_" + sessionId + ".jsonl");
  const user1 = message("user", "开始");
  fs.writeFileSync(file, line(header(sessionId, "/tmp/project")) + line(user1));

  const { events, adapter, hub } = makeAdapter(root);
  adapter.tick();
  assert.equal(hub.get("pi:" + sessionId).status, "working");

  events.length = 0;
  const failed = message("assistant", [], {
    stopReason: "error",
    parentId: user1.id,
  });
  failed.message.errorMessage = "provider exploded";
  fs.appendFileSync(file, line(failed));
  adapter.tick();

  const event = events.find((item) => item.type === EVENT.RUN_FAILED);
  assert.ok(event);
  assert.equal(event.payload.error, "provider exploded");
  assert.equal(hub.get("pi:" + sessionId).status, "failed");
});

test("Pi 适配器：aborted 发 run.canceled", () => {
  const { root, project } = setup();
  const sessionId = "sess-pi-abort";
  const file = path.join(project, "2026-10-25T02-00-00-000Z_" + sessionId + ".jsonl");
  const user1 = message("user", "开始");
  fs.writeFileSync(file, line(header(sessionId, "/tmp/project")) + line(user1));

  const { events, adapter } = makeAdapter(root);
  adapter.tick();

  events.length = 0;
  fs.appendFileSync(
    file,
    line(message("assistant", [], { stopReason: "aborted", parentId: user1.id }))
  );
  adapter.tick();
  assert.ok(events.find((item) => item.type === EVENT.RUN_CANCELED));
});

test("Pi 适配器：session_info 作为会话名，history 跟随活动分支", () => {
  const { root, project } = setup();
  const sessionId = "sess-pi-branch";
  const file = path.join(project, "2026-10-25T03-00-00-000Z_" + sessionId + ".jsonl");
  const u1 = message("user", "分支问题");
  const a1 = message("assistant", [{ type: "text", text: "分支回答" }], { stopReason: "stop", parentId: u1.id });
  const u2a = message("user", "旧分支", { parentId: a1.id });
  const a2a = message("assistant", [{ type: "text", text: "旧分支回答" }], { stopReason: "stop", parentId: u2a.id });
  const u2b = message("user", "新分支", { parentId: a1.id });
  const a2b = message("assistant", [{ type: "text", text: "新分支回答" }], { stopReason: "stop", parentId: u2b.id });
  const info = {
    type: "session_info",
    id: "info1",
    parentId: a2b.id,
    timestamp: new Date().toISOString(),
    name: "我的 Pi 会话",
  };

  fs.writeFileSync(
    file,
    line(header(sessionId, "/tmp/project")) + line(u1) + line(a1) +
      line(u2a) + line(a2a) + line(u2b) + line(a2b) + line(info)
  );

  const { adapter, hub } = makeAdapter(root);
  adapter.tick();
  const record = hub.get("pi:" + sessionId);
  assert.equal(record.title, "我的 Pi 会话");
  assert.equal(record.turns, 3, "文件里三个 user 条目；历史按活动分支只算两个");

  const history = adapter.history("pi:" + sessionId, { limit: 10 });
  assert.equal(history.total, 2);
  assert.equal(history.turns[0].prompt, "分支问题");
  assert.equal(history.turns[1].prompt, "新分支");
  assert.equal(history.turns[1].response, "新分支回答");
});
