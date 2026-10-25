import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import {
  addTerminal,
  currentTerminal,
  listTerminals,
  removeTerminal,
  setDefaultTerminal,
} from "../lib/terminals.mjs";

/**
 * mo terminal list|add|remove|use
 *
 * 决定会话型 worker 派单时用哪个终端开窗口。
 */

const SOURCE_LABEL = { builtin: "内置", custom: "自定义" };

export function terminalCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  const home = moHome();
  if (sub === "list") return listCommand(args, home);
  if (sub === "add") return addCommand(args, home);
  if (sub === "remove") return removeCommand(args, home);
  if (sub === "use") return useCommand(args, home);
  if (sub === "current") return currentCommand(args, home);
  throw new MoError("E_USAGE", "未知子命令：terminal " + sub + "（可用：list / add / remove / use）");
}

function listCommand(args, home) {
  const items = listTerminals({ home });
  const rows = items.map((item) => [
    item.name,
    SOURCE_LABEL[item.source] || item.source,
    item.default ? "✓" : "",
    item.command || "（内置驱动）",
    item.description || "",
  ]);

  emit(args.options, { terminals: items, current: currentTerminal({ home }) }, () =>
    [
      table(rows, ["终端", "来源", "默认", "命令", "说明"]).replace(/[ \t]+$/gm, ""),
      "",
      "设置默认：mo terminal use <名称>",
      '自定义：mo terminal add <名称> --command \'tmux new-window "bash {script}"\'',
    ].join("\n"),
  );
  return 0;
}

function addCommand(args, home) {
  const name = args.positional[1];
  if (!name) throw new MoError("E_USAGE", "缺少名称：mo terminal add <名称> --command '<模板>'");
  const result = addTerminal({
    home,
    name,
    command: one(args.options, "command", ""),
    description: one(args.options, "description", ""),
  });
  const used = has(args.options, "use");
  if (used) setDefaultTerminal({ home, name: result.name });

  emit(args.options, { ok: true, ...result, default: used }, () =>
    "✓ " + result.name + " → " + result.file + (used ? "（已设为默认）" : ""));
  return 0;
}

function removeCommand(args, home) {
  const name = args.positional[1];
  if (!name) throw new MoError("E_USAGE", "缺少名称：mo terminal remove <名称>");
  const result = removeTerminal({ home, name });
  emit(args.options, { ok: true, ...result }, "✓ 已移除 " + result.name);
  return 0;
}

function useCommand(args, home) {
  const name = args.positional[1];
  if (!name) {
    const current = currentTerminal({ home });
    emit(args.options, { current }, current || "（没有设默认，按自动探测）");
    return 0;
  }
  const result = setDefaultTerminal({ home, name });
  emit(args.options, { ok: true, ...result }, () =>
    "✓ 默认终端 = " + result.name + "（" + result.kind + "）；会话型派单会用它。");
  return 0;
}

function currentCommand(args, home) {
  const current = currentTerminal({ home });
  emit(args.options, { current }, current || "（没有设默认，按自动探测）");
  return 0;
}
