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
import { VERSION } from "./lib/version.mjs";

const HELP = [
  "mo —— 个人工作台 CLI",
  "",
  "用法：",
  "  mo worker list | add | remove       执行者（含自定义与可用性检测）",
  "  mo skill list | install | uninstall 安装 mo 技能到各 Agent 的技能目录",
  "",
  "  mo project init [路径]          初始化项目（.mo-agent/ + AGENTS.md）",
  "  mo project agent [--remove]     写/删 AGENTS.md、CLAUDE.md 里的 mo 说明",
  "  mo project list                 查看已登记项目",
  "",
  "  mo task create --title 标题 --deliverable 产出 [--verify \"run:命令\"] [--worker 执行者] [--exec 命令]",
  "  mo task confirm <id>            发起确认请求（不改状态；批准由人做）",
  "  mo task approve|reject <id>     人在终端批准 / 拒绝（需 TTY，--yes 跳过）",
  "  mo task requests                查看待批准的确认请求",
  "  mo task dispatch <id> [--worker 执行者] [--exec 命令]   派发并等待回执",
  "  mo task verify <id>             对已 done 的卡重跑验收",
  "  mo task status <id>             查看状态与最近事件",
  "  mo task logs <id> [--tail N]    看执行者完整日志",
  "  mo task list                    列出本项目任务",
  "  mo task cancel <id>             取消任务",
  "",
  "  mo receipt submit|apply <id>    提交/应用回执（apply 走验收）",
  "  mo ledger query [--project 项目] [--task id] [--days 30]",
  "",
  "  mo memory recall \"关键词\"        按记忆库召回（派单时同样会自动注入）",
  "  mo memory list                  列出记忆库条目",
  "  mo memory init                  创建记忆库骨架（幂等）",
  "  mo memory path                  打印记忆库位置",
  "  mo memory migrate [--dry-run]   把旧的 knowledge/ 搬到 memory/",
  "  mo memory propose --file -       提一条候选（等裁决，不直接进记忆库）",
  "  mo memory candidates            看候选区",
  "  mo memory accept|reject <id>    采纳 / 丢弃候选（冲突时拒绝写入）",
  "  mo inbox pull [--peek]          拉取任务通知（完成 / 阻塞 / 失败），拉完归档",
  "",
  "  mo mcp                          stdio MCP 服务（主 Agent 用，一行一条 JSON-RPC）",
  "  mo agent describe [--format …]   输出契约（prompt / skill / agent-block / mo-doc）",
  "  mo agent add --mcp <配置文件>     把 mo 合并进任意 mcpServers 配置（幂等 + 备份）",
  "  mo agent add --prompt            只打印可粘贴的提示词",
  "  mo help                         显示本帮助",
  "  mo doctor                       自检",
  "  mo completion bash|zsh          输出补全脚本（eval 即可）",
  "",
  "全局选项：--project <名称|路径>  --json  --help",
  "",
  "环境变量：MO_AGENT_HOME（默认 ~/.mo-agent）  MO_AGENT_MEMORY   MO_RECALL_LIMIT",
].join("\n");

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
    process.stdout.write(HELP + "\n");
    return 0;
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