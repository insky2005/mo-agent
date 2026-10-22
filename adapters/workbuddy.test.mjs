import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../core/hub.mjs";
import { EVENT } from "../core/events.mjs";
import { WorkBuddyAdapter, answerFrom, promptFrom } from "./workbuddy.mjs";
import { loadProfile, hookTarget } from "../approvals/hook-map.mjs";
import { createHooksManager, hookCommandFor, hookNodePath } from "../host/agent-hooks.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sessionId = "9b781026-9af0-4ad7-920a-6bb78ec443e0";
const cwd = "/tmp/wb-project";

function line(entry) {
  return JSON.stringify(entry) + "\n";
}

function userEntry(query, extra) {
  const text = extra || [
    "<system-reminder data-role=\"user-context\">",
    "<user_info>Workspace Folder: " + cwd + "</user_info>",
    "<identity_context>SOUL.md / USER.md 等长文本</identity_context>",
    "</system-reminder>",
    "<user_query>" + query + "</user_query>",
  ].join("\n");
  return {
    id: "u-" + Math.random().toString(16).slice(2),
    type: "message",
    role: "user",
    sessionId,
    cwd,
    timestamp: Date.now(),
    content: [{ type: "input_text", text }],
  };
}

function assistantEntry(text, status) {
  return {
    id: "a-" + Math.random().toString(16).slice(2),
    type: "message",
    role: "assistant",
    status: status || "completed",
    sessionId,
    cwd,
    timestamp: Date.now(),
    content: text ? [{ type: "output_text", text }] : [],
  };
}

function titleEntry(title) {
  return { type: "ai-title", aiTitle: title, sessionId, cwd, timestamp: Date.now() };
}

function callEntry(name) {
  return {
    type: "function_call",
    name: name || "Bash",
    callId: "call_1",
    arguments: "{\"command\":\"ls\"}",
    sessionId,
    cwd,
    timestamp: Date.now(),
  };
}

function resultEntry(name) {
  return {
    type: "function_call_result",
    name: name || "Bash",
    callId: "call_1",
    status: "completed",
    output: { type: "text", text: "file-a\nfile-b" },
    sessionId,
    cwd,
    timestamp: Date.now(),
  };
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-workbuddy-"));
  const project = path.join(root, "Users-dev-WorkBuddy");
  fs.mkdirSync(project);
  return { root, project, file: path.join(project, sessionId + ".jsonl") };
}

function makeAdapter(root, extra) {
  const hub = new Hub({ log: quiet });
  const events = [];
  hub.store.subscribe((event) => events.push(event));
  const adapter = new WorkBuddyAdapter({
    hub,
    log: quiet,
    endQuietMs: 0,
    ...extra,
    profile: { id: "workbuddy", label: "WorkBuddy", session: { root } },
  });
  return { hub, events, adapter };
}

function cleanup(project) {
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
}

test("WorkBuddy：会话观测、ai-title、完成事件与轮次", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, [
    titleEntry("调用 authx-mcp"),
    userEntry("call authx-mcp read"),
    assistantEntry("已经调用完成"),
  ].map(line).join(""));

  const { hub, events, adapter } = makeAdapter(root);
  adapter.tick();

  const first = hub.get("workbuddy:" + sessionId);
  assert.equal(first.sessionId, "workbuddy:" + sessionId);
  assert.equal(first.agent, "workbuddy");
  assert.equal(first.agentLabel, "WorkBuddy");
  assert.equal(first.title, "调用 authx-mcp");
  assert.equal(first.lastPrompt, "call authx-mcp read");
  assert.equal(first.lastResponse, "已经调用完成");
  assert.equal(first.status, "completed");
  assert.equal(first.turns, 1);
  assert.equal(first.detail.permissionMode, null, "WorkBuddy 的 transcript 不带权限模式");
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0, "首扫不补历史完成");

  events.length = 0;
  fs.appendFileSync(file, line(userEntry("再跑一次")) + line(assistantEntry("第二次也完成了")));
  adapter.tick();

  const done = events.find((event) => event.type === EVENT.RUN_COMPLETED);
  assert.ok(done, "第二轮应发 run.completed");
  assert.equal(done.payload.sessionId, "workbuddy:" + sessionId);
  assert.equal(done.payload.text, "第二次也完成了");
  assert.equal(done.payload.sessionTitle, "调用 authx-mcp");
  const latest = hub.get("workbuddy:" + sessionId);
  assert.equal(latest.turns, 2);
  assert.equal(latest.lastPrompt, "再跑一次");
  assert.equal(latest.lastResponse, "第二次也完成了");
  assert.equal(latest.title, "调用 authx-mcp", "标题保持 ai-title");

  events.length = 0;
  fs.unlinkSync(file);
  adapter.tick();
  assert.ok(events.find((event) => event.type === EVENT.SESSION_REMOVED));
  cleanup(project);
});

test("WorkBuddy：function_call / result 不算新轮次，工具期间是 working", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, line(userEntry("跑个命令")) + line(callEntry("Bash")));

  const { hub, events, adapter } = makeAdapter(root);
  adapter.tick();
  assert.equal(hub.get("workbuddy:" + sessionId).turns, 1);
  assert.equal(hub.get("workbuddy:" + sessionId).status, "working");

  events.length = 0;
  fs.appendFileSync(file, line(resultEntry("Bash")) + line(assistantEntry("命令跑完了")));
  adapter.tick();

  const record = hub.get("workbuddy:" + sessionId);
  assert.equal(record.turns, 1, "工具结果不是用户提问");
  assert.equal(record.status, "completed");
  assert.equal(record.lastResponse, "命令跑完了");
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 1);
  cleanup(project);
});

test("WorkBuddy：assistant 之后又来工具调用，不判完成", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(
    file,
    line(userEntry("先解释再执行")) + line(assistantEntry("我先看看目录")) + line(callEntry("Bash"))
  );

  const { hub, events, adapter } = makeAdapter(root);
  adapter.tick();

  const record = hub.get("workbuddy:" + sessionId);
  assert.equal(record.status, "working", "assistant 后面的 function_call 说明这一轮没结束");
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0);
  cleanup(project);
});

test("WorkBuddy：结束信号有静默窗口，避免同一轮误判完成", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, line(userEntry("做完告诉我")) + line(assistantEntry("做完了")));

  const { hub, events, adapter } = makeAdapter(root, { endQuietMs: 2000 });
  adapter.tick();
  assert.equal(hub.get("workbuddy:" + sessionId).status, "working", "刚写完 assistant 时先等静默窗口");
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 0);

  adapter.endQuietMs = 0;
  adapter.tick();
  assert.equal(hub.get("workbuddy:" + sessionId).status, "completed");
  assert.equal(events.filter((event) => event.type === EVENT.RUN_COMPLETED).length, 1);
  cleanup(project);
});

test("WorkBuddy：从 system-reminder 里提取 <user_query>，没有标记时剥掉提醒", () => {
  assert.equal(promptFrom(userEntry("真正的问题")), "真正的问题");
  assert.equal(
    promptFrom(userEntry("", "<system-reminder data-role=\"user-context\">一大段上下文</system-reminder>\n普通提问")),
    "普通提问"
  );
  assert.equal(
    promptFrom(userEntry("", "<system-reminder data-role=\"user-context\">只有系统提醒</system-reminder>")),
    "",
    "只有 system-reminder 的条目不构成一轮"
  );
  assert.equal(promptFrom({ type: "message", role: "assistant", content: [] }), "");
  assert.equal(
    promptFrom({ type: "message", role: "user", content: "<user_query>字符串正文</user_query>" }),
    "字符串正文"
  );
});

test("WorkBuddy：assistant 兼容 output_text 与 text", () => {
  assert.equal(answerFrom(assistantEntry("output_text 正文")), "output_text 正文");
  assert.equal(
    answerFrom({ type: "message", role: "assistant", content: [{ type: "text", text: "text 正文" }] }),
    "text 正文"
  );
});

test("WorkBuddy：history 按轮次返回", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(
    file,
    line(userEntry("第一问")) + line(assistantEntry("第一答")) +
      line(userEntry("第二问")) + line(assistantEntry("第二答"))
  );

  const { adapter } = makeAdapter(root);
  adapter.tick();
  const history = adapter.history("workbuddy:" + sessionId, { limit: 20 });
  assert.deepEqual(history.turns, [
    { turn: 1, prompt: "第一问", response: "第一答" },
    { turn: 2, prompt: "第二问", response: "第二答" },
  ]);
  assert.equal(history.total, 2);
  cleanup(project);
});

test("WorkBuddy：大 transcript 只读尾部时，轮次与标题仍正确", () => {
  const { root, file, project } = makeRoot();
  const filler = "很长的回答".repeat(30000);
  fs.writeFileSync(
    file,
    [
      titleEntry("大文件会话"),
      userEntry("第一问"),
      assistantEntry(filler),
      userEntry("第二问"),
      assistantEntry(filler),
      userEntry("第三问"),
      assistantEntry("短回答"),
    ].map(line).join("")
  );
  assert.ok(fs.statSync(file).size > 512 * 1024);

  const { hub, adapter } = makeAdapter(root);
  adapter.tick();
  const record = hub.get("workbuddy:" + sessionId);
  assert.equal(record.turns, 3, "前缀里的 3 轮也要算上");
  assert.equal(record.title, "大文件会话");
  assert.equal(record.lastPrompt, "第三问");
  cleanup(project);
});

test("WorkBuddy：没有 ai-title 时用第一问截断，卡片不被长 prompt 撑满", () => {
  const { root, file, project } = makeRoot();
  fs.writeFileSync(file, line(userEntry("长问题".repeat(30))) + line(assistantEntry("好")));

  const { hub, adapter } = makeAdapter(root);
  adapter.tick();
  const title = hub.get("workbuddy:" + sessionId).title;
  assert.ok(title.length <= 60, "标题不超过 60 字");
  assert.ok(title.endsWith("…"), "截断要有省略号");
  cleanup(project);
});


test("WorkBuddy：hook-cli 的 PermissionRequest 输出 decision.behavior", async () => {
  const http = await import("node:http");
  const { spawn } = await import("node:child_process");
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ decision: "allow" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const cli = path.join(process.cwd(), "approvals", "hook-cli.mjs");
  const child = spawn(process.execPath, [cli, "event", "PermissionRequest", "workbuddy"], {
    env: { ...process.env, MO_AGENT_URL: "http://127.0.0.1:" + port, MO_AGENT_TOKEN: "test-token" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({
    session_id: "hook-session",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    cwd: "/tmp/wb",
  }));
  const output = await new Promise((resolve, reject) => {
    let data = "";
    child.stdout.on("data", (chunk) => (data += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(data);
      else reject(new Error("hook-cli exited " + code));
    });
  });
  await new Promise((resolve) => server.close(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/local/approval");
  assert.equal(requests[0].body.agent, "workbuddy");
  assert.equal(requests[0].body.sessionId, "hook-session");
  assert.equal(requests[0].body.toolName, "Bash");
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PermissionRequest");
  assert.equal(parsed.hookSpecificOutput.decision.behavior, "allow");
});

test("WorkBuddy：profile 的 hook 映射与一键配置", () => {
  const profile = loadProfile("workbuddy");
  assert.ok(profile, "profile 必须存在");
  assert.equal(profile.hooks.kind, "workbuddy");
  assert.equal(profile.hooks.settingsFile, "~/.workbuddy/settings.json");
  assert.equal(hookTarget("event", profile, "PermissionRequest"), "approval.pending");
  assert.equal(hookTarget("event", profile, "Notification"), "notice");
  assert.match(
    hookCommandFor({ root: "/repo", agentId: "workbuddy", event: "PermissionRequest" }),
    /event PermissionRequest workbuddy$/
  );

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-workbuddy-home-"));
  const settingsFile = path.join(home, ".workbuddy", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ sandbox: { extraAllowWrite: ["/tmp/keep"] } }));
  const manager = createHooksManager({ root: process.cwd(), home, profiles: [profile], log: quiet });

  const [installed] = manager.apply({ agentId: "workbuddy" });
  assert.equal(installed.ok, true);
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(settings.sandbox, { extraAllowWrite: ["/tmp/keep"] }, "不能碰用户的 sandbox 配置");
  assert.equal(settings.hooks.PermissionRequest.length, 1);
  const installedCommand = settings.hooks.PermissionRequest[0].hooks[0].command;
  assert.match(installedCommand, /event PermissionRequest workbuddy$/);
  const nodePath = hookNodePath(profile);
  assert.ok(path.isAbsolute(nodePath), "WorkBuddy 的 hook 应写绝对 node 路径");
  assert.ok(installedCommand.startsWith('"' + nodePath + '"'), "hook 命令使用绝对 node 路径");
  assert.equal(manager.status().find((item) => item.id === "workbuddy").installed, true);

  const [removed] = manager.apply({ agentId: "workbuddy", action: "uninstall" });
  assert.equal(removed.ok, true);
  const after = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(after.hooks, undefined, "卸载后只删 mo-agent 的 hook");
  assert.deepEqual(after.sandbox, { extraAllowWrite: ["/tmp/keep"] });
  fs.rmSync(home, { recursive: true, force: true });
});
