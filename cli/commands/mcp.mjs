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