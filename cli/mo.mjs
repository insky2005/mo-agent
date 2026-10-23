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
import { runCommand } from "./commands/run.mjs";
import { doctorCommand } from "./commands/doctor.mjs";

const HELP = [
  "mo —— 个人工作台 CLI",
  "",
  "用法：",
  "  mo project add [路径] [--name 名称]   登记项目（写入 .mo-agent/project.json）",
  "  mo project list                      查看已登记项目",
  "",
  "  mo task create --title 标题 --deliverable 产出 [--verify \"run:命令\"] [--exec 命令]",
  "  mo task confirm <id>                 确认任务卡（确认权属于人）",
  "  mo task dispatch <id> [--exec 命令]   派发并等待回执",
  "  mo task status <id>                  查看状态与最近事件",
  "  mo task list                         列出本项目任务",
  "  mo task cancel <id>                  取消任务",
  "",
  "  mo run <id> [--exec 命令]             执行（卡片已确认/已派发时可用）",
  "  mo receipt submit <id> --file -       提交回执（stdin）",
  "  mo ledger query [--project 项目] [--task id] [--days 30]",
  "  mo doctor                            自检",
  "",
  "全局选项：--project <名称|路径>  --json  --help",
  "",
  "环境变量：MO_AGENT_HOME（默认 ~/.mo-agent）",
].join("\n");

const ROUTES = {
  project: projectCommand,
  task: taskCommand,
  receipt: receiptCommand,
  ledger: ledgerCommand,
  run: runCommand,
  doctor: doctorCommand,
};

async function main(argv) {
  const args = parseArgs(argv);
  const group = args.positional[0];

  if (!group || group === "help" || group === "--help" || args.options.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (group === "--version" || group === "version") {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    process.stdout.write(require("../../package.json").version + "\n");
    return 0;
  }

  const handler = ROUTES[group];
  if (!handler) {
    throw new MoError("E_USAGE", "未知命令：" + group + "（mo help 查看用法）");
  }

  const ctx = { cwd: process.cwd(), env: process.env };
  const subArgs = { positional: args.positional.slice(1), options: args.options };
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
