import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-mcp-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, project, home };
}

function run(ws, args) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: ws.project,
    env: { ...process.env, MO_AGENT_HOME: ws.home },
    encoding: "utf8",
  });
}

/** 起一个 mcp 子进程，按行收发 JSON-RPC；onServerRequest 处理 server→client 请求 */
function session(ws, options = {}) {
  const child = spawn(process.execPath, [MO, "mcp"], {
    cwd: ws.project,
    env: { ...process.env, MO_AGENT_HOME: ws.home },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let buffer = "";
  const queued = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      // server → client 请求（elicitation）：由测试替代客户端应答，不进入回包队列
      if (options.onServerRequest && message.method) {
        options.onServerRequest(message);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queued.push(message);
    }
  });

  return {
    child,
    send: (message) => child.stdin.write(JSON.stringify(message) + "\n"),
    next: () =>
      new Promise((resolve, reject) => {
        if (queued.length) return resolve(queued.shift());
        const timer = setTimeout(() => reject(new Error("等待 MCP 回包超时")), 15000);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        child.on("close", resolve);
        child.stdin.end();
      }),
  };
}

async function handshake(s, capabilities = {}) {
  s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities } });
  const init = await s.next();
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return init;
}

test("initialize 返回 serverInfo 与 tools 能力", async () => {
  const ws = workspace();
  const s = session(ws);
  const init = await handshake(s);
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, "mo");
  assert.ok(init.result.serverInfo.version);
  assert.ok(init.result.capabilities.tools);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  await s.close();
});

test("tools/list 暴露工具，但不暴露 task_confirm（B4.5）", async () => {
  const ws = workspace();
  const s = session(ws);
  await handshake(s);
  s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const reply = await s.next();
  const names = reply.result.tools.map((tool) => tool.name);
  for (const name of ["task_create", "task_confirm", "task_dispatch", "task_status", "inbox_pull", "ledger_query", "memory_recall", "memory_propose"]) {
    assert.ok(names.includes(name), "缺少工具 " + name);
  }
  // confirm 只是发起请求，批准必须由人做，所以 approve 永远不暴露
  assert.ok(!names.includes("task_approve"), "批准权不能给主 Agent");
  assert.ok(!names.includes("task_reject"), "拒绝权不能给主 Agent");
  assert.ok(!names.includes("memory_accept"), "采纳记忆属于人的裁决");
  for (const tool of reply.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
  }
  await s.close();
});

test("tools/call task_create 走 CLI 并返回 draft 卡", async () => {
  const ws = workspace();
  run(ws, ["project", "add", "."]);
  const s = session(ws);
  await handshake(s);

  s.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "task_create",
      arguments: {
        title: "加筛选栏",
        deliverables: ["app/web/tasks.html 有筛选栏"],
        verify: ["run:node -e 0"],
      },
    },
  });
  const reply = await s.next();
  assert.equal(reply.result.isError, false, JSON.stringify(reply));
  const payload = JSON.parse(reply.result.content[0].text);
  assert.match(payload.taskId, /^t_/);
  assert.equal(payload.status, "draft");
  assert.equal(fs.existsSync(payload.path), true);
  await s.close();
});

test("tools/call memory_recall 读到知识库", async () => {
  const ws = workspace();
  run(ws, ["memory", "init"]);
  fs.writeFileSync(path.join(ws.home, "memory", "pitfalls", "x.md"), "## 回执超时先看日志\n\n- trigger: 回执, 超时\n\n先看 logs。\n", "utf8");

  const s = session(ws);
  await handshake(s);
  s.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "memory_recall", arguments: { query: "回执 超时" } },
  });
  const reply = await s.next();
  const payload = JSON.parse(reply.result.content[0].text);
  assert.equal(payload.matched[0].title, "回执超时先看日志");
  await s.close();
});

test("tools/call memory_propose 落候选区", async () => {
  const ws = workspace();
  run(ws, ["memory", "init"]);
  const s = session(ws);
  await handshake(s);
  s.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "memory_propose",
      arguments: { title: "先问再做", trigger: ["删除"], body: "改动前先说明。" },
    },
  });
  const reply = await s.next();
  const payload = JSON.parse(reply.result.content[0].text);
  assert.match(payload.id, /^c_/);
  assert.equal(fs.existsSync(payload.path), true);
  await s.close();
});

test("工具失败时 isError=true，并把错误码带回来", async () => {
  const ws = workspace();
  const s = session(ws);
  await handshake(s);
  s.send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "task_status", arguments: { taskId: "t_missing" } },
  });
  const reply = await s.next();
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /E_/);
  await s.close();
});

test("缺必填参数直接报错，不落到 CLI", async () => {
  const ws = workspace();
  const s = session(ws);
  await handshake(s);
  s.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "task_create", arguments: { title: "x" } } });
  const reply = await s.next();
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /缺少参数.*deliverables/);
  await s.close();
});

test("未知方法与坏 JSON 有稳定回包", async () => {
  const ws = workspace();
  const s = session(ws);
  await handshake(s);
  s.send({ jsonrpc: "2.0", id: 8, method: "nope/nope" });
  const unknown = await s.next();
  assert.equal(unknown.error.code, -32601);

  s.child.stdin.write("{not json}\n");
  const broken = await s.next();
  assert.equal(broken.error.code, -32700);
  await s.close();
});
function mcpProject(ws) {
  run(ws, ["project", "add", "."]);
  const created = run(ws, ["task", "create", "--title", "加筛选", "--deliverable", "有筛选栏", "--json"]);
  return JSON.parse(created.stdout.trim()).taskId;
}

test("声明 elicitation 的客户端：task_confirm 当场批准", async () => {
  const ws = workspace();
  const taskId = mcpProject(ws);

  let asked = null;
  const s = session(ws, {
    onServerRequest: (message) => {
      if (message.method !== "elicitation/create") return;
      asked = message;
      s.send({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { decision: "approve" } } });
    },
  });
  await handshake(s, { elicitation: {} });
  s.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "task_confirm", arguments: { taskId } } });
  const reply = await s.next();

  assert.ok(asked, "应该向客户端发出 elicitation/create");
  assert.equal(asked.params.requestedSchema.properties.decision.enum.join(","), "approve,reject");
  assert.match(asked.params.message, /加筛选/);

  const payload = JSON.parse(reply.result.content[0].text);
  assert.equal(reply.result.isError, false, JSON.stringify(reply));
  assert.equal(payload.status, "confirmed");

  const ledger = JSON.parse(run(ws, ["ledger", "query", "--task", taskId, "--json"]).stdout.trim());
  const confirmed = ledger.events.find((event) => event.type === "task.confirmed");
  assert.equal(confirmed.payload.channel, "mcp-elicitation");
  assert.equal(confirmed.actor, "human");
  await s.close();
});

test("用户在表单里拒绝：卡保持 draft", async () => {
  const ws = workspace();
  const taskId = mcpProject(ws);

  const s = session(ws, {
    onServerRequest: (message) => {
      if (message.method === "elicitation/create") {
        s.send({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { decision: "reject" } } });
      }
    },
  });
  await handshake(s, { elicitation: {} });
  s.send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "task_confirm", arguments: { taskId } } });
  const reply = await s.next();
  const payload = JSON.parse(reply.result.content[0].text);
  assert.equal(payload.rejected, true);

  const status = JSON.parse(run(ws, ["task", "status", taskId, "--json"]).stdout.trim());
  assert.equal(status.status, "draft");
  await s.close();
});

test("用户关掉表单（decline）：请求保持 pending", async () => {
  const ws = workspace();
  const taskId = mcpProject(ws);

  const s = session(ws, {
    onServerRequest: (message) => {
      if (message.method === "elicitation/create") {
        s.send({ jsonrpc: "2.0", id: message.id, result: { action: "decline" } });
      }
    },
  });
  await handshake(s, { elicitation: {} });
  s.send({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "task_confirm", arguments: { taskId } } });
  const reply = await s.next();
  const payload = JSON.parse(reply.result.content[0].text);
  assert.equal(payload.pending, true);

  const requests = JSON.parse(run(ws, ["task", "requests", "--json"]).stdout.trim());
  assert.equal(requests.total, 1);
  await s.close();
});

test("没声明 elicitation 的客户端：退回 pending 流程", async () => {
  const ws = workspace();
  const taskId = mcpProject(ws);

  let asked = false;
  const s = session(ws, {
    onServerRequest: (message) => {
      if (message.method === "elicitation/create") asked = true;
    },
  });
  await handshake(s);
  s.send({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "task_confirm", arguments: { taskId } } });
  const reply = await s.next();
  const payload = JSON.parse(reply.result.content[0].text);
  assert.equal(asked, false, "不应向不支持 elicitation 的客户端发表单");
  assert.equal(payload.pending, true);
  await s.close();
});

test("MO_ELICITATION=0 时即使有能力也不弹表单", async () => {
  const ws = workspace();
  const taskId = mcpProject(ws);
  process.env.MO_ELICITATION = "0";

  let asked = false;
  const s = session(ws, {
    onServerRequest: (message) => {
      if (message.method === "elicitation/create") asked = true;
    },
  });
  await handshake(s, { elicitation: {} });
  s.send({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "task_confirm", arguments: { taskId } } });
  const reply = await s.next();
  assert.equal(asked, false);
  assert.equal(JSON.parse(reply.result.content[0].text).pending, true);
  await s.close();
  delete process.env.MO_ELICITATION;
});
