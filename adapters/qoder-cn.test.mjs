import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../core/hub.mjs";
import { EVENT } from "../core/events.mjs";
import { QoderCnAdapter } from "./qoder-cn.mjs";
import { loadProfile, hookTarget } from "../approvals/hook-map.mjs";
import { hookCommandFor } from "../host/agent-hooks.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 观测测试不读真实 SQLite：默认没有标题，必要时单独注入。 */
function noTitles() {
  return { title: () => "", refresh() {} };
}
const sessionId = "9caae06c-acd9-49c8-a8ac-d146cf507b9d";

function line(entry) {
  return JSON.stringify(entry) + "\n";
}

/** 按本机真实 transcript 的形状造条目（含桌面端的元数据噪声）。 */
function transcript({ prompt, answer, permissionMode }) {
  return [
    { type: "workspace-directories", sessionId, directories: ["/tmp/project"] },
    { type: "runtime-config", sessionId, model: "qmodel", timestamp: Date.now() },
    {
      type: "user",
      uuid: "u-1",
      sessionId,
      cwd: "/tmp/project",
      timestamp: "2026-10-16T01:48:28.743Z",
      permissionMode: permissionMode || "auto",
      entrypoint: "cli",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
      humanInput: { text: prompt, mode: "prompt" },
    },
    { type: "attachment", sessionId, attachment: { type: "skill_listing", content: "..." } },
    { type: "active-leaf", sessionId, leafUuid: "u-1" },
    { type: "last-prompt", sessionId, lastPrompt: prompt },
    {
      type: "assistant",
      uuid: "a-1",
      sessionId,
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: answer }] },
    },
  ];
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-qoder-"));
  const project = path.join(root, "-Users-dev-project");
  fs.mkdirSync(project);
  return { root, project, file: path.join(project, sessionId + ".jsonl") };
}

function collect(adapter, events) {
  adapter.tick();
  return events;
}

test("Qoder CN：会话观测、标题、完成事件", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, transcript({ prompt: "优化客户端权限交互", answer: "改完了" }).map(line).join(""));
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { id: "qoder-cn", label: "Qoder CN", session: { root } } });

  collect(adapter, events);
  const first = events.filter((event) => event.type === EVENT.SESSION_UPSERT).pop().payload;
  assert.equal(first.sessionId, "qoder-cn:" + sessionId);
  assert.equal(first.agent, "qoder-cn");
  assert.equal(first.agentLabel, "Qoder CN");
  assert.equal(first.title, "优化客户端权限交互");
  assert.equal(first.lastPrompt, "优化客户端权限交互");
  assert.equal(first.lastResponse, "改完了");
  assert.equal(first.status, "completed");
  assert.equal(first.detail.permissionMode, "auto", "权限模式来自 user 条目，不是独立条目");
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0, "首扫不补历史完成");

  events.length = 0;
  fs.appendFileSync(file, line({
    type: "user",
    sessionId,
    cwd: "/tmp/project",
    permissionMode: "default",
    message: { role: "user", content: [{ type: "text", text: "再改一处" }] },
  }) + line({
    type: "assistant",
    sessionId,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "第二处也改了" }] },
  }));
  collect(adapter, events);

  const done = events.find((event) => event.type === EVENT.RUN_COMPLETED);
  assert.ok(done);
  assert.equal(done.payload.sessionId, "qoder-cn:" + sessionId);
  assert.equal(done.payload.text, "第二处也改了");
  assert.equal(done.payload.sessionTitle, "优化客户端权限交互");
  const latest = events.filter((event) => event.type === EVENT.SESSION_UPSERT).pop().payload;
  assert.equal(latest.title, "优化客户端权限交互", "标题保持第一问");
  assert.equal(latest.lastPrompt, "再改一处");
  assert.equal(latest.detail.permissionMode, "default");

  events.length = 0;
  fs.unlinkSync(file);
  collect(adapter, events);
  assert.ok(events.find((event) => event.type === EVENT.SESSION_REMOVED));
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：tool_result 不算新的一轮，tool_use 期间是 working", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, transcript({ prompt: "跑个命令", answer: "先看看" }).map(line).join(""));
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();

  events.length = 0;
  fs.appendFileSync(file, line({
    type: "assistant",
    sessionId,
    message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } }] },
  }) + line({
    type: "user",
    sessionId,
    toolUseResult: {},
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
  }));
  adapter.tick();

  const record = hub.get("qoder-cn:" + sessionId);
  assert.equal(record.turns, 1, "工具结果不是用户提问");
  assert.equal(record.status, "working");
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0);
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：没有 ai-title 时标题用第一问，last-prompt 不覆盖后续问题", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(
    file,
    line({ type: "user", sessionId, message: { content: [{ type: "text", text: "第一问" }] } }) +
      line({ type: "last-prompt", sessionId, lastPrompt: "第一问" }) +
      line({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text: "答一" }] } }) +
      line({ type: "user", sessionId, message: { content: [{ type: "text", text: "第二问" }] } })
  );
  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();
  const record = hub.get("qoder-cn:" + sessionId);
  assert.equal(record.title, "第一问");
  assert.equal(record.lastPrompt, "第二问");
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：history 按轮次返回", async () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(
    file,
    line({ type: "user", sessionId, message: { content: [{ type: "text", text: "第一问" }] } }) +
      line({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text: "第一答" }] } }) +
      line({ type: "user", sessionId, message: { content: [{ type: "text", text: "第二问" }] } }) +
      line({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text: "第二答" }] } })
  );
  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();
  const history = await adapter.history("qoder-cn:" + sessionId, { limit: 20 });
  assert.deepEqual(history.turns, [
    { turn: 1, prompt: "第一问", response: "第一答" },
    { turn: 2, prompt: "第二问", response: "第二答" },
  ]);
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：profile 的 hook 映射与一键配置命令", () => {
  const profile = loadProfile("qoder-cn");
  assert.ok(profile, "profile 必须存在");
  assert.equal(profile.hooks.kind, "qoder-cn");
  assert.equal(profile.hooks.settingsFile, "~/.qoder-cn/settings.json");
  assert.equal(profile.hooks.settingsFiles, undefined, "不要写 Qoder 国际版的 ~/.qoder/settings.json");
  assert.equal(hookTarget("event", profile, "PermissionRequest"), "approval.pending");
  assert.equal(hookTarget("event", profile, "Notification"), "notice");
  assert.match(hookCommandFor({ root: "/repo", agentId: "qoder-cn", event: "PermissionRequest" }), /event PermissionRequest qoder-cn$/);
});

test("Qoder CN：大 transcript 只读尾部时，轮次与「查看完整」一致", async () => {
  const { root, file, project } = makeRoot();
  const user = (text) => line({ type: "user", sessionId, message: { content: [{ type: "text", text }] } });
  const answer = (text) => line({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text }] } });
  const filler = "很长的回答".repeat(30000); // 约 300KB，确保文件超过 512KB 只读尾部阈值
  fs.writeFileSync(file, user("第一问") + answer(filler) + user("第二问") + answer(filler) + user("第三问") + answer("短回答"));
  assert.ok(fs.statSync(file).size > 512 * 1024);

  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();
  const record = hub.get("qoder-cn:" + sessionId);
  assert.equal(record.turns, 3, "前缀里的 3 轮也要算上");
  assert.equal(record.title, "第一问");

  const history = await adapter.history("qoder-cn:" + sessionId, { limit: 50 });
  assert.equal(history.total, 3, "卡片轮次与详情总轮次一致");
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：isMeta 注入不算用户轮次", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(
    file,
    line({ type: "user", sessionId, isMeta: true, message: { content: [{ type: "text", text: "系统注入的上下文" }] } }) +
      line({ type: "user", sessionId, message: { content: [{ type: "text", text: "真正的问题" }] } }) +
      line({ type: "assistant", sessionId, message: { stop_reason: "end_turn", content: [{ type: "text", text: "回答" }] } })
  );
  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();
  assert.equal(hub.get("qoder-cn:" + sessionId).turns, 1);
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：优先使用 SQLite 里的会话标题", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, transcript({ prompt: "关于 manager 里客户端权限的授权，交互方式需要优化下，要更直观、更简易", answer: "好" }).map(line).join(""));
  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({
    hub,
    log: quiet,
    profile: { session: { root } },
    titleSource: { title: (id) => (id === sessionId ? "优化客户端权限交互" : ""), refresh() {} },
  });
  adapter.tick();
  assert.equal(hub.get("qoder-cn:" + sessionId).title, "优化客户端权限交互");
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：没有标题时截断第一问，卡片不会被长 prompt 撑满", () => {
  const { root, file, project } = makeRoot();
  const prompt = "这是一段很长很长的用户提问".repeat(12);
  fs.writeFileSync(file, transcript({ prompt, answer: "好" }).map(line).join(""));
  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();
  const title = hub.get("qoder-cn:" + sessionId).title;
  assert.ok(title.length <= 60, "标题不超过 60 字");
  assert.ok(title.endsWith("…"), "截断要有省略号");
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：标题晚到时会重新发布会话", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, transcript({ prompt: "先给个临时标题", answer: "好" }).map(line).join(""));
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  let exact = "";
  const adapter = new QoderCnAdapter({
    hub,
    log: quiet,
    titleSource: { title: () => exact, refresh() {} },
    profile: { session: { root } },
  });
  adapter.tick();
  assert.equal(hub.get("qoder-cn:" + sessionId).title, "先给个临时标题");

  events.length = 0;
  exact = "真正的会话标题";
  adapter.tick();
  const latest = events.filter((event) => event.type === EVENT.SESSION_UPSERT).pop();
  assert.ok(latest, "标题变化要重新 upsert");
  assert.equal(latest.payload.title, "真正的会话标题");
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});
