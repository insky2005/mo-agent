import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit, isJson } from "../lib/output.mjs";
import { VERSION } from "../lib/version.mjs";
import { FORBIDDEN, RULES, TOOLS, render } from "../../core/manager/contract.mjs";

/**
 * 通用接入：mo 不认识任何具体 Agent。
 *
 *   mo agent               → 怎么接（人看的概览 + 三条路，各带命令）
 *   mo agent describe      → 同上（描述契约）
 *   mo agent describe --json   → 机器读的契约
 *   mo agent describe --prompt → 可粘贴的契约文本（默认不打印，见上）
 *   mo agent describe --skill  → 技能文件内容
 *   mo agent add --mcp <file>  → 合并 mcpServers
 *   mo agent add --prompt      → 只打印提示词
 */

const USAGE = "可用：describe / add";

export function agentCommand(ctx, args) {
  const sub = args.positional[0];
  if (!sub || sub === "help") return describeCommand(args);
  if (sub === "describe") return describeCommand(args);
  if (sub === "add") return addCommand(ctx, args);
  throw new MoError("E_USAGE", "未知子命令：agent " + sub + "（" + USAGE + "）");
}

/** 给人看的概览：工具、边界、以及"到底该怎么接" */
function overview() {
  const toolRows = TOOLS.map((tool) => "  " + tool.name.padEnd(16) + tool.description);
  const forbiddenRows = FORBIDDEN.map((item) => "  - " + item.cli + "（" + item.why + "）");

  return [
    "mo —— 让任意 Agent 当「主 Agent」",
    "",
    "它能调用 " + TOOLS.length + " 个工具：",
    ...toolRows,
    "",
    "它不能做：",
    ...forbiddenRows,
    "",
    "怎么接（三选一，按对方能力）：",
    "",
    "  1. 只会聊天的 Agent",
    "       mo agent add --prompt | pbcopy      # macOS；其它系统重定向到文件",
    "     粘进它的系统提示，它就能照着跑。",
    "",
    "  2. 支持 stdio MCP 的 Agent",
    "       mo agent add --mcp ./mcp.json",
    "     合并进它的 mcpServers（幂等、自动备份），工具直接可用，不用贴提示词。",
    "",
    "  3. 想让它懂「什么时候该派活、回显后要停下等批准」",
    "       mo skill install      # 全局，所有会话生效",
    "       mo project init       # 或者只给这个仓库写 AGENTS.md",
    "",
    "机器可读的契约：mo agent describe --json",
  ].join("\n");
}

function describeCommand(args) {
  if (isJson(args.options)) {
    emit(args.options, {
      ok: true,
      name: "mo",
      version: VERSION,
      tools: TOOLS.map(({ name, description, schema }) => ({ name, description, schema })),
      forbidden: FORBIDDEN,
      rules: RULES,
    });
    return 0;
  }

  // 一条路只留一个命令：要提示词去 add --prompt，要项目块去 project init
  if (has(args.options, "prompt") || has(args.options, "skill") || has(args.options, "format")) {
    throw new MoError("E_USAGE", "describe 只做「说明」，不输出可粘贴内容", {
      hint: "要提示词：mo agent add --prompt；要项目内 AGENTS.md / MO.md：mo project init",
    });
  }

  process.stdout.write(overview() + "\n");
  return 0;
}

/** 当前这个 mo 怎么被 MCP 客户端启动 */
function selfEntry() {
  const script = process.argv[1];
  if (script && script.endsWith(".mjs") && fs.existsSync(script)) {
    return { command: process.execPath, args: [path.resolve(script), "mcp"] };
  }
  return { command: process.execPath, args: ["mcp"] };
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

/**
 * 合并 mcpServers：幂等（内容没变就不写）、写前备份。
 * mo agent add 与 mo setup 共用这一份逻辑。
 */
export function mergeMcpConfig({ target, serverName = "mo", entry } = {}) {
  const file = path.resolve(String(target));
  const server = String(serverName || "mo");
  const self = entry || selfEntry();

  let config = {};
  let backup = null;
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new MoError("E_USAGE", "现有配置不是合法 JSON：" + file, { hint: "先修好它，或换个 --mcp 目标" });
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new MoError("E_USAGE", "现有配置不是 JSON 对象：" + file);
    }
  }

  const before = JSON.stringify(config);
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  config.mcpServers[server] = self;
  const after = JSON.stringify(config);
  const changed = before !== after;

  if (changed) {
    if (fs.existsSync(file)) {
      backup = file + ".bak-" + stamp();
      fs.copyFileSync(file, backup);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tmp, file);
  }

  return { file, server, ...self, backup, changed };
}

function addCommand(ctx, args) {
  if (has(args.options, "prompt")) {
    process.stderr.write("[mo] 已输出可粘贴的契约文本\n");
    process.stdout.write(render("prompt"));
    return 0;
  }

  const file = one(args.options, "mcp");
  if (!file || file === true) {
    throw new MoError("E_USAGE", "缺少配置目标", {
      hint: "mo agent add --mcp ./mcp.json（只能读文字的 Agent 用 mo agent add --prompt）",
    });
  }

  const result = mergeMcpConfig({ target: path.resolve(ctx.cwd, String(file)), serverName: String(one(args.options, "name", "mo")) });

  emit(
    args.options,
    { ok: true, ...result },
    () =>
      [
        result.changed ? "✓ 已写入 MCP 配置" : "= 配置已是最新，没有改动",
        "",
        "  文件   " + result.file,
        "  服务   " + result.server,
        "  命令   " + result.command + " " + result.args.join(" "),
        ...(result.backup ? ["  备份   " + result.backup] : []),
        "",
        "下一步：确认该客户端已启用这段配置，然后新开会话。",
      ].join("\n"),
  );
  return 0;
}
