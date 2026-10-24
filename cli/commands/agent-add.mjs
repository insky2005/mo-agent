import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { isJson } from "../lib/output.mjs";
import { VERSION } from "../lib/version.mjs";
import { FORBIDDEN, FORMATS, RULES, TOOLS, render } from "../../core/manager/contract.mjs";

/**
 * 通用接入：mo 不认识任何具体 Agent，只产出三种可粘贴物——
 *   describe：契约（人看的文本 / 机器读的 JSON）
 *   add --mcp：往任意 mcpServers 配置里合并一段
 *   add --prompt：把 prompt 打到 stdout，自己贴到没有配置文件的地方
 */

const USAGE = "可用：describe / add";

export function agentCommand(ctx, args) {
  const sub = args.positional[0];
  if (sub === "describe") return describeCommand(args);
  if (sub === "add") return addCommand(ctx, args);
  throw new MoError("E_USAGE", "未知子命令：agent " + (sub || "") + "（" + USAGE + "）");
}

function describeCommand(args) {
  const format = String(one(args.options, "format", "prompt"));

  if (isJson(args.options)) {
    emit(args.options, {
      ok: true,
      name: "mo",
      version: VERSION,
      tools: TOOLS.map(({ name, description, schema }) => ({ name, description, schema })),
      forbidden: FORBIDDEN,
      rules: RULES,
      formats: FORMATS,
    });
    return 0;
  }

  if (format === "list") {
    const rows = TOOLS.map((tool) => [tool.name, tool.description]);
    emit(args.options, { formats: FORMATS, tools: TOOLS.map((tool) => tool.name) }, () =>
      "可用格式：" + FORMATS.join(" / ") + "\n\n" + rows.map(([name, desc]) => name.padEnd(18) + desc).join("\n"));
    return 0;
  }

  process.stdout.write(render(format));
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

function addCommand(ctx, args) {
  if (has(args.options, "prompt")) {
    process.stdout.write(render("prompt"));
    return 0;
  }

  const file = one(args.options, "mcp");
  if (!file || file === true) {
    throw new MoError("E_USAGE", "缺少配置目标", {
      hint: "mo agent add --mcp ./mcp.json（或在支持 MCP 的客户端配置里手贴 mo agent describe --format prompt）",
    });
  }

  const target = path.resolve(ctx.cwd, String(file));
  const serverName = String(one(args.options, "name", "mo"));
  const entry = selfEntry();

  let config = {};
  let backup = null;
  if (fs.existsSync(target)) {
    try {
      config = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch {
      throw new MoError("E_USAGE", "现有配置不是合法 JSON：" + target, { hint: "先修好它，或换个 --mcp 目标" });
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new MoError("E_USAGE", "现有配置不是 JSON 对象：" + target);
    }
  }

  const before = JSON.stringify(config);
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  config.mcpServers[serverName] = entry;
  const after = JSON.stringify(config);
  const changed = before !== after;

  if (changed) {
    if (fs.existsSync(target)) {
      backup = target + ".bak-" + stamp();
      fs.copyFileSync(target, backup);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    const tmp = target + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tmp, target);
  }

  emit(
    args.options,
    { ok: true, file: target, server: serverName, ...entry, backup, changed },
    () =>
      [
        changed ? "✓ 已写入 MCP 配置" : "= 配置已是最新，没有改动",
        "",
        "  文件   " + target,
        "  服务   " + serverName,
        "  命令   " + entry.command + " " + entry.args.join(" "),
        ...(backup ? ["  备份   " + backup] : []),
        "",
        "下一步：确认该客户端已启用这段配置，然后新开会话。",
      ].join("\n"),
  );
  return 0;
}
