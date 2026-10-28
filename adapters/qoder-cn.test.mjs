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

/** 起一个假 host，跑真实的 hook-cli，返回它写给 Agent 的 JSON。 */
async function runHookCli({ input, decision, answers }) {
  const http = await import("node:http");
  const { spawn } = await import("node:child_process");
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answers ? { decision, answers } : { decision }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const cli = path.join(process.cwd(), "approvals", "hook-cli.mjs");
  const child = spawn(process.execPath, [cli, "event", "PermissionRequest", "qoder-cn"], {
    env: { ...process.env, MO_AGENT_URL: "http://127.0.0.1:" + port, MO_AGENT_TOKEN: "test-token" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(input));
  const output = await new Promise((resolve, reject) => {
    let data = "";
    child.stdout.on("data", (chunk) => (data += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(data) : reject(new Error("hook-cli exited " + code))));
  });
  await new Promise((resolve) => server.close(resolve));
  return { requests, parsed: output ? JSON.parse(output) : null };
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

test("Qoder CN IDE：PermissionRequest 用 permissionDecision，不能输出对象 decision", async () => {
  const { requests, parsed } = await runHookCli({
    input: {
      session_id: "ide-hook-1",
      transcript_path: "/Users/x/.qoder-cn/projects/p/transcript/s.jsonl",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      cwd: "/tmp/ide",
    },
    decision: "allow_once",
  });
  assert.equal(requests.length, 1);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PermissionRequest");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(parsed.hookSpecificOutput.decision, undefined, "新运行时把 decision 当 string，不能出现对象");
});

test("Qoder CN IDE：拒绝用 permissionDecision=deny 并带原因", async () => {
  const { parsed } = await runHookCli({
    input: {
      session_id: "ide-hook-2",
      transcript_path: "/Users/x/.qoder-cn/projects/p/transcript/s.jsonl",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x" },
      cwd: "/tmp/ide",
    },
    decision: "reject_once",
  });
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /拒绝/);
  assert.equal(parsed.hookSpecificOutput.decision, undefined);
});

test("Qoder CN IDE：AskUserQuestion 的答案写回 updatedInput", async () => {
  const questions = [{ question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }];
  const { parsed } = await runHookCli({
    input: {
      session_id: "ide-hook-3",
      transcript_path: "/Users/x/.qoder-cn/projects/p/transcript/s.jsonl",
      tool_name: "AskUserQuestion",
      tool_input: { questions },
      cwd: "/tmp/ide",
    },
    decision: "allow_once",
    answers: { "选哪个？": "A" },
  });
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(parsed.hookSpecificOutput.updatedInput.questions, questions);
  assert.equal(parsed.hookSpecificOutput.updatedInput.answers["选哪个？"], "A");
});

test("Qoder CN 桌面端：PermissionRequest 保持 decision.behavior", async () => {
  const { parsed } = await runHookCli({
    input: {
      session_id: "desktop-hook-1",
      transcript_path: "/Users/x/.qoder-cn/projects/p/s.jsonl",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      cwd: "/tmp/desktop",
    },
    decision: "allow_once",
  });
  assert.equal(parsed.hookSpecificOutput.decision.behavior, "allow");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined, "老运行时只认 decision.behavior");
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

test("Qoder CN：上下文压缩后，卡片仍显示最后一条人类提问", async () => {
  const { root, file, project } = makeRoot();
  const prompt = "切分支，然后按阶段实施，先完成 P1";
  const entries = [
    { type: "user", sessionId, origin: { kind: "human" }, humanInput: { text: prompt, mode: "prompt" }, message: { role: "user", content: [{ type: "text", text: prompt }] } },
    { type: "assistant", sessionId, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "中间过程".repeat(50000) }] } },
    { type: "assistant", sessionId, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "更多过程".repeat(50000) }] } },
    { type: "user", sessionId, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: [{ type: "text", text: "This session is being continued from a previous conversation…" }] } }
  ];
  fs.writeFileSync(file, entries.map(line).join(""));
  // 人类提问必须落在尾部 512KB 之外，模拟压缩后 transcript 变很大
  assert.ok(fs.statSync(file).size > 512 * 1024);

  fs.appendFileSync(file, line({ type: "assistant", sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "P1 已完成" }] } }));
  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();

  const record = hub.get("qoder-cn:" + sessionId);
  assert.equal(record.lastPrompt, prompt, "压缩后仍能看到最后一条人类提问");
  assert.equal(record.lastResponse, "P1 已完成");
  assert.equal(record.turns, 1, "压缩摘要不算一轮");
  const history = await adapter.history("qoder-cn:" + sessionId, { limit: 20 });
  assert.equal(history.total, 1, "详情里也不显示压缩摘要");
  assert.equal(history.turns[0].prompt, prompt);
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN：压缩摘要本身不算用户提问", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(
    file,
    line({ type: "user", sessionId, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: [{ type: "text", text: "This session is being continued…" }] } }) +
      line({ type: "assistant", sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "继续完成" }] } })
  );
  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();
  const record = hub.get("qoder-cn:" + sessionId);
  assert.equal(record.turns, 0);
  assert.equal(record.lastPrompt, "");
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

test("Qoder CN IDE：会话在 <project>/transcript/ 子目录里也能观测", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-qoder-"));
  const project = path.join(root, "-Users-dev-ide-project");
  const nested = path.join(project, "transcript");
  fs.mkdirSync(nested, { recursive: true });
  const id = "9085e591-a5d0-4b95-8173-4e48375426c9";
  fs.writeFileSync(path.join(nested, id + ".jsonl"),
    line({ type: "session_meta", sessionId: id, cwd: "/tmp/ide", data: { meta_type: "session_info" } }) +
    line({ type: "user", sessionId: id, cwd: "/tmp/ide", message: { role: "user", content: "IDE 里的第一个问题" } }) +
    line({ type: "assistant", sessionId: id, cwd: "/tmp/ide", message: { role: "assistant", content: [{ type: "text", text: "IDE 回答" }] } })
  );
  const hub = new Hub({ log: quiet });
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();
  const record = hub.get("qoder-cn:" + id);
  assert.ok(record, "嵌套目录里的会话也要出现");
  assert.equal(record.title, "IDE 里的第一个问题");
  assert.equal(record.agentLabel, "Qoder CN IDE", "IDE 会话要有独立标签");
  assert.equal(record.lastResponse, "IDE 回答");
  fs.rmSync(root, { recursive: true, force: true });
});

test("Qoder CN：新一轮提问后、回答前，不显示上一轮回复", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, transcript({ prompt: "第一问", answer: "第一答" }).map(line).join(""));
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  const adapter = new QoderCnAdapter({ hub, log: quiet, titleSource: noTitles(), profile: { session: { root } } });
  adapter.tick();
  assert.equal(hub.get("qoder-cn:" + sessionId).lastResponse, "第一答");

  events.length = 0;
  fs.appendFileSync(file, line({ type: "user", sessionId, cwd: "/tmp/project", message: { role: "user", content: "第二问" } }));
  adapter.tick();
  const waiting = hub.get("qoder-cn:" + sessionId);
  assert.equal(waiting.lastPrompt, "第二问");
  assert.equal(waiting.lastResponse, "", "Agent 还没回复时不能显示上一轮回答");

  events.length = 0;
  fs.appendFileSync(file, line({ type: "assistant", sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "第二答" }] } }));
  adapter.tick();
  assert.equal(hub.get("qoder-cn:" + sessionId).lastResponse, "第二答");
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});
