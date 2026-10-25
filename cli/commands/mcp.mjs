import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../lib/version.mjs";
import { TOOLS as CONTRACT_TOOLS } from "../../core/manager/contract.mjs";

/**
 * mo mcp —— stdio 薄壳（spec §9）。
 *
 * 不重写业务逻辑：每个工具调用都转成一次 `mo <path> --json` 子进程，
 * 结果原样回给客户端。这样 MCP 与 CLI 永远不会有两套行为。
 *
 * 传输：按 MCP stdio 约定，一行一个 JSON-RPC 消息；日志只走 stderr。
 */

const PROTOCOL_VERSION = "2025-06-18";

/** 客户端是否声明了 elicitation 能力（initialize 时告知） */
let clientElicitation = false;
/** server → client 的请求（elicitation）等待中的回调 */
const serverRequests = new Map();
let serverRequestSeq = 0;

/** 让客户端弹表单；用户关掉/超时都按 cancel 处理，绝不默认通过 */
function askClient(params, timeoutMs = 5 * 60 * 1000) {
  const id = "srv-" + (serverRequestSeq += 1);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      serverRequests.delete(id);
      resolve({ action: "cancel", reason: "timeout" });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    serverRequests.set(id, (result) => {
      clearTimeout(timer);
      resolve(result || { action: "cancel" });
    });
    send({ jsonrpc: "2.0", id, method: "elicitation/create", params });
  });
}

/**
 * task_confirm 的 elicitation 版本：先落请求，再让客户端弹表单，最后按用户选择施加决定。
 * 走这条路时账本记 channel=mcp-elicitation，与终端/网页区分开。
 */
async function confirmWithElicitation(args) {
  const taskId = String(args.taskId || "");
  const prepared = await runCli(["task", "confirm", taskId, "--json"]);
  const preparedText = (prepared.stdout || prepared.stderr).trim();
  if (prepared.code !== 0) return { result: textResult(preparedText || "发起确认请求失败", true) };

  let info = null;
  try {
    info = JSON.parse(prepared.stdout);
  } catch {
    info = null;
  }
  if (info && (info.status === "confirmed" || info.alreadyConfirmed)) {
    return { result: textResult(JSON.stringify(info, null, 2)) };
  }

  const answer = await askClient({
    message: "确认任务卡「" + ((info && info.title) || taskId) + "」？批准后主 Agent 才能派单。",
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          title: "决定",
          description: "允许后这张卡才能派发",
          enum: ["approve", "reject"],
          enumNames: ["允许", "拒绝"],
        },
      },
      required: ["decision"],
    },
  });

  const decision = answer && answer.action === "accept" && answer.content ? String(answer.content.decision || "") : "";
  if (!decision) {
    return {
      result: textResult(
        JSON.stringify(
          {
            ok: true,
            pending: true,
            taskId,
            requestId: info && info.requestId,
            note: "用户没有在表单里做决定，请求仍然待批",
          },
          null,
          2,
        ),
      ),
    };
  }

  const action = decision === "approve" ? "approve" : "reject";
  const applied = await runCli(["task", action, taskId, "--yes", "--channel", "mcp-elicitation", "--json"]);
  const body = applied.stdout.trim() || applied.stderr.trim() || "（无输出）";
  return { result: textResult(body, applied.code !== 0) };
}

/** 自我定位：源码运行时 execPath + cli/mo.mjs，单文件二进制时直接 execPath */
function selfCommand() {
  try {
    const entry = fileURLToPath(new URL("../mo.mjs", import.meta.url));
    if (fs.existsSync(entry)) return { command: process.execPath, prefix: [entry] };
  } catch {
    // 单文件二进制里 import.meta.url 不是真实路径，落到下面的分支
  }
  return { command: process.execPath, prefix: [] };
}

function runCli(args, { input, cwd } = {}) {
  return new Promise((resolve) => {
    const self = selfCommand();
    const child = spawn(self.command, [...self.prefix, ...args, "--json"], {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, stdout: "", stderr: String(error && error.message) }));
    child.on("close", (code) => resolve({ code: code === null ? 1 : code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function flag(list, name, values) {
  for (const value of values || []) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    list.push("--" + name, String(value));
  }
}

/** 数组型参数一项一个 flag，避免和 shell 的逗号语义纠缠 */
function repeat(list, name, values) {
  if (!Array.isArray(values)) return;
  for (const value of values) list.push("--" + name, String(value));
}

/** 工具语义（名字 / 描述 / schema）来自 contract；这里只负责映射成 CLI 参数 */
const BUILDERS = {
  task_create: {
    build: (args) => {
      const list = ["task", "create"];
      flag(list, "title", [args.title]);
      repeat(list, "deliverable", args.deliverables);
      repeat(list, "verify", args.verify);
      repeat(list, "boundary", args.boundaries);
      repeat(list, "constraint", args.constraints);
      flag(list, "background", [args.background]);
      flag(list, "project", [args.project]);
      flag(list, "worker", [args.worker]);
      flag(list, "exec", [args.exec]);
      flag(list, "timeout", [args.timeout]);
      return list;
    },
  },
  task_confirm: {
    build: (args) => {
      const list = ["task", "confirm", String(args.taskId)];
      flag(list, "wait", [args.wait]);
      flag(list, "project", [args.project]);
      return list;
    },
  },
  task_dispatch: {
    build: (args) => {
      const list = ["task", "dispatch", String(args.taskId)];
      flag(list, "worker", [args.worker]);
      flag(list, "exec", [args.exec]);
      flag(list, "timeout", [args.timeout]);
      flag(list, "project", [args.project]);
      return list;
    },
  },
  task_status: {
    build: (args) => {
      const list = ["task", "status", String(args.taskId)];
      flag(list, "project", [args.project]);
      return list;
    },
  },
  inbox_pull: {
    build: (args) => {
      const list = ["inbox", "pull"];
      if (args.peek) list.push("--peek");
      flag(list, "task", [args.taskId]);
      flag(list, "limit", [args.limit]);
      return list;
    },
  },
  ledger_query: {
    build: (args) => {
      const list = ["ledger", "query"];
      flag(list, "project", [args.project]);
      flag(list, "task", [args.taskId]);
      flag(list, "type", [args.type]);
      flag(list, "days", [args.days]);
      flag(list, "limit", [args.limit]);
      return list;
    },
  },
  memory_recall: {
    build: (args) => {
      const list = ["memory", "recall", String(args.query)];
      flag(list, "limit", [args.limit]);
      flag(list, "scope", [args.scope]);
      return list;
    },
  },
  memory_propose: {
    build: () => ["memory", "propose", "--file", "-"],
    input: (args) =>
      JSON.stringify({
        scope: args.scope || "pitfalls",
        title: args.title,
        trigger: args.trigger,
        tags: args.tags || [],
        body: args.body,
        source: "agent",
      }),
  },
};

function byName(name) {
  return CONTRACT_TOOLS.find((tool) => tool.name === name) || null;
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(params) {
  const tool = byName(params && params.name);
  if (!tool) return { error: { code: -32602, message: "未知工具：" + (params && params.name) } };

  // 客户端支持 elicitation 时，确认请求当场问人；MO_ELICITATION=0 可强制走带外通道
  if (tool.name === "task_confirm" && clientElicitation && process.env.MO_ELICITATION !== "0") {
    const args = (params && params.arguments) || {};
    if (!args.taskId) return { result: textResult("缺少参数：taskId（工具 task_confirm）", true) };
    return confirmWithElicitation(args);
  }

  const builder = BUILDERS[tool.name];
  if (!builder) return { error: { code: -32603, message: "工具缺少 CLI 映射：" + tool.name } };

  const args = (params && params.arguments) || {};
  const missing = ((tool.schema && tool.schema.required) || []).filter((key) => args[key] === undefined || args[key] === null || args[key] === "");
  if (missing.length) {
    return { result: textResult("缺少参数：" + missing.join(", ") + "（工具 " + tool.name + "）", true) };
  }

  const cliArgs = builder.build(args);
  const input = builder.input ? builder.input(args) : undefined;
  const outcome = await runCli(cliArgs, { input });

  const body = outcome.stdout.trim();
  const text = body || outcome.stderr.trim() || "（无输出）";
  return { result: textResult(outcome.code === 0 ? text : text + (outcome.stderr.trim() && body ? "\n" + outcome.stderr.trim() : ""), outcome.code !== 0) };
}

async function handle(message) {
  const { id, method, params } = message || {};

  if (method === "initialize") {
    clientElicitation = Boolean(params && params.capabilities && params.capabilities.elicitation);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "mo", version: VERSION },
      },
    };
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled" || id === undefined) {
    return null; // 通知不需要回包
  }

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: CONTRACT_TOOLS.map(({ name, description, schema }) => ({ name, description, inputSchema: schema })) },
    };
  }

  if (method === "tools/call") {
    const outcome = await callTool(params);
    if (outcome.error) return { jsonrpc: "2.0", id, error: outcome.error };
    return { jsonrpc: "2.0", id, result: outcome.result };
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: "不支持的方法：" + method } };
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/** 逐行读 stdin，逐条回包；MCP 的 stdio 传输约定就是一行一条消息 */
export function mcpCommand(ctx, args) {
  process.stderr.write("[mo] mcp stdio 已就绪（" + CONTRACT_TOOLS.length + " 个工具）\n");

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) dispatchLine(line);
    }
  });

  const pending = [];
  function dispatchLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
      return;
    }
    // server → client 请求的回包：只有 id 没有 method
    if (message && message.method === undefined && message.id !== undefined && serverRequests.has(message.id)) {
      const settle = serverRequests.get(message.id);
      serverRequests.delete(message.id);
      settle(message.result || { action: "cancel", reason: message.error ? "error" : "cancel" });
      return;
    }

    const job = handle(message)
      .then((reply) => {
        if (reply) send(reply);
      })
      .catch((error) => {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error && error.message) } });
      });
    pending.push(job);
  }

  return new Promise((resolve) => {
    process.stdin.on("end", async () => {
      await Promise.allSettled(pending);
      resolve(0);
    });
  });
}