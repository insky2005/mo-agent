import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../lib/version.mjs";

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

const TOOLS = [
  {
    name: "task_create",
    description: "建一张 draft 任务卡（未确认，不能派单）。返回 taskId 与卡片路径。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句话标题" },
        deliverables: { type: "array", items: { type: "string" }, description: "交付物清单，至少一条" },
        verify: { type: "array", items: { type: "string" }, description: '验收项，形如 "run:npm test" / "check:文件含X" / "human:视觉确认"' },
        boundaries: { type: "array", items: { type: "string" }, description: "边界（不要做什么）" },
        constraints: { type: "array", items: { type: "string" }, description: "约束" },
        background: { type: "string", description: "背景" },
        project: { type: "string", description: "项目名或路径，缺省用当前目录绑定的项目" },
        worker: { type: "string", description: "内置执行者名，与 exec 二选一" },
        exec: { type: "string", description: "自定义执行命令，如 \"claude -p\"" },
        timeout: { type: "string", description: "形如 45m / 2h" },
      },
      required: ["title", "deliverables"],
    },
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
  {
    name: "task_dispatch",
    description: "派发已确认的任务卡，前台等待执行者跑完并做验收。可能耗时数分钟。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        worker: { type: "string" },
        exec: { type: "string" },
        timeout: { type: "string" },
        project: { type: "string" },
      },
      required: ["taskId"],
    },
    build: (args) => {
      const list = ["task", "dispatch", String(args.taskId)];
      flag(list, "worker", [args.worker]);
      flag(list, "exec", [args.exec]);
      flag(list, "timeout", [args.timeout]);
      flag(list, "project", [args.project]);
      return list;
    },
  },
  {
    name: "task_status",
    description: "查任务状态、验收结果与最近事件。汇报只引用这里的字段。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, project: { type: "string" } },
      required: ["taskId"],
    },
    build: (args) => {
      const list = ["task", "status", String(args.taskId)];
      flag(list, "project", [args.project]);
      return list;
    },
  },
  {
    name: "inbox_pull",
    description: "拉取任务通知（done / blocked / failed），拉完归档；主 Agent 用它替代推送。",
    inputSchema: {
      type: "object",
      properties: {
        peek: { type: "boolean", description: "只看不归档" },
        taskId: { type: "string" },
        limit: { type: "number" },
      },
    },
    build: (args) => {
      const list = ["inbox", "pull"];
      if (args.peek) list.push("--peek");
      flag(list, "task", [args.taskId]);
      flag(list, "limit", [args.limit]);
      return list;
    },
  },
  {
    name: "ledger_query",
    description: "查账本事件（机器事实，优先于任何转述）。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        taskId: { type: "string" },
        type: { type: "string", description: "事件类型前缀，如 task." },
        days: { type: "number" },
        limit: { type: "number" },
      },
    },
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
  {
    name: "memory_recall",
    description: "按关键词从知识库召回条目（派单时同一条通道会自动注入）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        scope: { type: "string", description: "preferences / pitfalls / decisions" },
      },
      required: ["query"],
    },
    build: (args) => {
      const list = ["memory", "recall", String(args.query)];
      flag(list, "limit", [args.limit]);
      flag(list, "scope", [args.scope]);
      return list;
    },
  },
  {
    name: "memory_propose",
    description: "提一条记忆候选（不进知识库，等人裁决）。缺触发条件会被拒收。",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "preferences / pitfalls / decisions，默认 pitfalls" },
        title: { type: "string" },
        trigger: { type: "array", items: { type: "string" }, description: "触发条件，必填" },
        tags: { type: "array", items: { type: "string" } },
        body: { type: "string" },
      },
      required: ["title", "trigger", "body"],
    },
    build: (args) => ["memory", "propose", "--file", "-"],
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
];

function byName(name) {
  return TOOLS.find((tool) => tool.name === name) || null;
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(params) {
  const tool = byName(params && params.name);
  if (!tool) return { error: { code: -32602, message: "未知工具：" + (params && params.name) } };

  const args = (params && params.arguments) || {};
  const missing = (tool.inputSchema.required || []).filter((key) => args[key] === undefined || args[key] === null || args[key] === "");
  if (missing.length) {
    return { result: textResult("缺少参数：" + missing.join(", ") + "（工具 " + tool.name + "）", true) };
  }

  const cliArgs = tool.build(args);
  const input = tool.input ? tool.input(args) : undefined;
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
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
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
  process.stderr.write("[mo] mcp stdio 已就绪（" + TOOLS.length + " 个工具）\n");

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
