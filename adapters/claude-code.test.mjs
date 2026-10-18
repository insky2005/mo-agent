import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../core/hub.mjs";
import { EVENT } from "../core/events.mjs";
import { ClaudeCodeAdapter } from "./claude-code.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function line(entry) {
  return JSON.stringify(entry) + "\n";
}

test("Claude 适配器：session.upsert、最新问题、每轮完成事件", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-claude-"));
  const project = path.join(root, "-tmp-project");
  fs.mkdirSync(project);
  const sessionId = "sess-test-1";
  const file = path.join(project, sessionId + ".jsonl");
  const user = (text) => ({ type: "user", sessionId, cwd: "/tmp/project", message: { content: text } });
  const assistant = (text, stop) => ({
    type: "assistant",
    sessionId,
    message: { stop_reason: stop || "end_turn", content: [{ type: "text", text }] },
  });

  fs.writeFileSync(file, line(user("第一个问题")) + line(assistant("第一轮回答")));
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  const adapter = new ClaudeCodeAdapter({ hub, log: quiet, profile: { session: { root } } });
  adapter.tick();

  assert.equal(events.some((event) => event.type === "agent.updated"), false);
  let upserts = events.filter((event) => event.type === "session.upsert");
  assert.ok(upserts.length >= 1);
  let record = upserts[upserts.length - 1].payload;
  assert.equal(record.sessionId, "claude-code:" + sessionId);
  assert.equal(record.agentLabel, "Claude Code");
  assert.equal(record.lastPrompt, "第一个问题");
  assert.equal(record.title, "第一个问题");
  // 首次扫描只建立基线，不能补发历史完成通知
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0);

  events.length = 0;
  fs.appendFileSync(
    file,
    line(user("第二个问题")) + line(assistant("第二轮回答")) + line({ type: "system", subtype: "turn_duration", sessionId })
  );
  adapter.tick();

  upserts = events.filter((event) => event.type === "session.upsert");
  record = upserts[upserts.length - 1].payload;
  assert.equal(record.lastPrompt, "第二个问题");
  assert.equal(record.title, "第一个问题", "会话名保持第一问，不随每轮变化");
  assert.equal(record.lastResponse, "第二轮回答");
  assert.equal(record.status, "completed", "尾部的 system 元数据不能把状态改成 idle");
  const done = events.find((event) => event.type === EVENT.RUN_COMPLETED);
  assert.ok(done);
  assert.equal(done.payload.sessionId, "claude-code:" + sessionId);
  assert.equal(done.payload.sessionTitle, "第一个问题");
  assert.equal(done.payload.text, "第二轮回答");

  fs.unlinkSync(file);
  events.length = 0;
  adapter.tick();
  const removed = events.find((event) => event.type === "session.removed");
  assert.ok(removed);
  assert.equal(removed.payload.sessionId, "claude-code:" + sessionId);
});

test("Claude 适配器：启动时已在跑，结束时仍发完成通知", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-claude-"));
  const project = path.join(root, "-tmp-project");
  fs.mkdirSync(project);
  const sessionId = "sess-test-3";
  const file = path.join(project, sessionId + ".jsonl");
  const user = { type: "user", sessionId, message: { content: "正在处理的问题" } };
  const assistant = { type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text: "处理完了" }] } };

  fs.writeFileSync(file, line(user));
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  const adapter = new ClaudeCodeAdapter({ hub, log: quiet, profile: { session: { root } } });
  adapter.tick();
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0);

  events.length = 0;
  fs.appendFileSync(file, line(assistant));
  adapter.tick();
  const done = events.find((event) => event.type === EVENT.RUN_COMPLETED);
  assert.ok(done, "启动时正在跑的轮次，结束时也要通知");
  assert.equal(done.payload.text, "处理完了");
});

test("Claude 适配器：last-prompt 不会覆盖真实的后续问题", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-claude-"));
  const project = path.join(root, "-tmp-project");
  fs.mkdirSync(project);
  const sessionId = "sess-test-2";
  const file = path.join(project, sessionId + ".jsonl");
  fs.writeFileSync(
    file,
    line({ type: "user", sessionId, message: { content: "第一问" } }) +
      line({ type: "last-prompt", sessionId, lastPrompt: "第一问" }) +
      line({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text: "答一" }] } }) +
      line({ type: "last-prompt", sessionId, lastPrompt: "第一问" }) +
      line({ type: "user", sessionId, message: { content: "第二问" } })
  );
  const hub = new Hub({ log: quiet });
  const adapter = new ClaudeCodeAdapter({ hub, log: quiet, profile: { session: { root } } });
  adapter.tick();
  const record = hub.get("claude-code:" + sessionId);
  assert.ok(record);
  assert.equal(record.lastPrompt, "第二问");
  assert.equal(record.title, "第一问", "last-prompt 不能改写稳定的会话名");
});

test("Claude 适配器：runEnd: none 只更新状态，不发 run.*", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-claude-"));
  const project = path.join(root, "-tmp-project");
  fs.mkdirSync(project);
  const sessionId = "sess-test-none";
  const file = path.join(project, sessionId + ".jsonl");
  const user = (text) => ({ type: "user", sessionId, message: { content: text } });
  const assistant = (text) => ({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text }] } });

  fs.writeFileSync(file, line(user("第一问")) + line(assistant("答一")));
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  const adapter = new ClaudeCodeAdapter({
    hub,
    log: quiet,
    profile: { session: { root }, capabilities: { runEnd: "none" } },
  });
  adapter.tick();
  events.length = 0;
  fs.appendFileSync(file, line(user("第二问")) + line(assistant("答二")));
  adapter.tick();
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0);
  assert.equal(events.filter((event) => event.type === EVENT.RUN_STARTED).length, 0);
  assert.equal(hub.get("claude-code:" + sessionId).status, "completed");
});

test("大 transcript：只读尾部时，标题仍来自第一问", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-claude-"));
  const project = path.join(root, "-tmp-project");
  fs.mkdirSync(project);
  const sessionId = "sess-test-large";
  const file = path.join(project, sessionId + ".jsonl");
  const user = (text) => ({ type: "user", sessionId, message: { content: text } });
  const assistant = (text) => ({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text }] } });

  fs.writeFileSync(
    file,
    line(user("第一问")) +
      line(assistant("很长的回答".repeat(120000))) +
      line(user("最后一问")) +
      line(assistant("最后回答"))
  );
  const hub = new Hub({ log: quiet });
  const adapter = new ClaudeCodeAdapter({ hub, log: quiet, profile: { session: { root } } });
  adapter.tick();
  const record = hub.get("claude-code:" + sessionId);
  assert.ok(record);
  assert.equal(record.title, "第一问");
  assert.equal(record.lastPrompt, "最后一问");
});
test("Claude 适配器：详情文本保留换行", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-claude-"));
  const project = path.join(root, "-tmp-project");
  fs.mkdirSync(project);
  const sessionId = "sess-test-lines";
  const file = path.join(project, sessionId + ".jsonl");
  const user = { type: "user", sessionId, message: { content: "第一行\n第二行" } };
  const assistant = { type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text: "回答第一行\n回答第二行" }] } };
  fs.writeFileSync(file, line(user) + line(assistant));
  const hub = new Hub({ log: quiet });
  const adapter = new ClaudeCodeAdapter({ hub, log: quiet, profile: { session: { root } } });
  adapter.tick();
  const record = hub.get("claude-code:" + sessionId);
  assert.ok(record);
  assert.match(record.lastPrompt, /第一行\n第二行/);
  assert.match(record.lastResponse, /回答第一行\n回答第二行/);
});
test("history 返回所有轮次", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-claude-"));
  const project = path.join(root, "-tmp-project");
  fs.mkdirSync(project);
  const sessionId = "sess-test-history";
  const file = path.join(project, sessionId + ".jsonl");
  const user = (text) => ({ type: "user", sessionId, message: { content: text } });
  const assistant = (text) => ({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text }] } });
  fs.writeFileSync(file, line(user("第一问")) + line(assistant("第一答")) + line(user("第二问")) + line(assistant("第二答")));
  const hub = new Hub({ log: quiet });
  const adapter = new ClaudeCodeAdapter({ hub, log: quiet, profile: { session: { root } } });
  adapter.tick();
  const history = await adapter.history("claude-code:" + sessionId, { limit: 20 });
  assert.deepEqual(history.turns, [
    { turn: 1, prompt: "第一问", response: "第一答" },
    { turn: 2, prompt: "第二问", response: "第二答" },
  ]);
});
