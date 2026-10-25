#!/usr/bin/env node
/**
 * mo —— 个人工作台 CLI（P0）
 *
 * 分工：core/ 放纯逻辑（状态机、卡片、回执、账本事件），cli/ 负责 IO 与命令。
 * 设计见 docs/spec/workbench-flow.md。
 */
import { parseArgs } from "./lib/args.mjs";
import { MoError } from "../core/errors.mjs";
import { projectCommand } from "./commands/project.mjs";
import { taskCommand } from "./commands/task.mjs";
import { receiptCommand } from "./commands/receipt.mjs";
import { ledgerCommand } from "./commands/ledger.mjs";
import { doctorCommand } from "./commands/doctor.mjs";
import { completionCommand, completeCommand } from "./commands/completion.mjs";
import { workerCommand } from "./commands/worker.mjs";
import { skillCommand } from "./commands/skill.mjs";
import { memoryCommand } from "./commands/memory.mjs";
import { inboxCommand } from "./commands/inbox.mjs";
import { mcpCommand } from "./commands/mcp.mjs";
import { agentCommand } from "./commands/agent-add.mjs";
import { terminalCommand } from "./commands/terminal.mjs";
import { watchdogCommand } from "./commands/watchdog.mjs";
import { VERSION } from "./lib/version.mjs";
import { groupNames, renderGroupHelp, renderHelp } from "./lib/help.mjs";

function printHelp(topic) {
  if (!topic) {
    process.stdout.write(renderHelp() + "\n");
    return 0;
  }
  const text = renderGroupHelp(topic);
  if (!text) {
    process.stderr.write("没有这个组：" + topic + "（可用：" + groupNames().join(" / ") + "）\n");
    return 2;
  }
  process.stdout.write(text + "\n");
  return 0;
}

const ROUTES = {
  project: projectCommand,
  task: taskCommand,
  receipt: receiptCommand,
  ledger: ledgerCommand,
  doctor: doctorCommand,
  completion: completionCommand,
  worker: workerCommand,
  skill: skillCommand,
  memory: memoryCommand,
  inbox: inboxCommand,
  mcp: mcpCommand,
  agent: agentCommand,
  terminal: terminalCommand,
  watchdog: watchdogCommand,
};

async function main(argv) {
  // 补全回调走原始 argv：parseArgs 会把 --ti 这类半截参数吃掉
  if (argv[0] === "__complete") {
    const raw = argv.slice(1);
    const describe = raw[0] === "--describe";
    const words = describe ? raw.slice(1) : raw;
    return completeCommand({ cwd: process.cwd() }, { words, describe });
  }

  const args = parseArgs(argv);
  const group = args.positional[0];

  if (args.options.version || group === "version" || group === "--version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (!group || group === "help" || group === "--help" || args.options.help) {
    // mo help task / mo task --help / mo help 都走同一套
    const topic = group && group !== "help" && group !== "--help" ? group : args.positional[1];
    return printHelp(topic);
  }

  // mo task help 等价于 mo help task
  if (args.positional[1] === "help" && groupNames().includes(group)) {
    return printHelp(group);
  }

  const ctx = { cwd: process.cwd(), env: process.env };
  const subArgs = { positional: args.positional.slice(1), options: args.options };

  const handler = ROUTES[group];
  if (!handler) {
    throw new MoError("E_USAGE", "未知命令：" + group + "（mo help 查看用法）");
  }

  return await handler(ctx, subArgs);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = typeof code === "number" ? code : 0;
  })
  .catch((error) => {
    if (error instanceof MoError) {
      process.stderr.write("[" + error.code + "] " + error.message + "\n");
      if (error.details && error.details.hint) process.stderr.write("  " + error.details.hint + "\n");
      if (error.details && error.details.candidates) {
        process.stderr.write("  候选：" + JSON.stringify(error.details.candidates) + "\n");
      }
      process.exitCode = error.code === "E_USAGE" ? 2 : 1;
      return;
    }
    process.stderr.write((error && error.stack ? error.stack : String(error)) + "\n");
    process.exitCode = 1;
  });