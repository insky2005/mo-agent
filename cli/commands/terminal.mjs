import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import {
  addTerminal,
  currentTerminal,
  listTerminals,
  removeTerminal,
  resolveTerminal,
  setDefaultTerminal,
} from "../lib/terminals.mjs";

const REASON_LABEL = {
  "env:MO_LAUNCHER": "环境变量 MO_LAUNCHER",
  "env:MO_LAUNCH_CMD": "环境变量 MO_LAUNCH_CMD",
  "env:MO_TERMINAL": "环境变量 MO_TERMINAL",
  default: "已设默认",
  auto: "自动探测",
};

/** 这次派单实际会用的终端；解析失败时退回空值，不让 list 挂掉 */
function effectiveFor(home) {
  try {
    return resolveTerminal({ home });
  } catch (error) {
    return { name: "", kind: "unknown", reason: "error", error: error.message };
  }
}

function describeEffective(effective) {
  if (!effective.name) return "（解析失败：" + (effective.error || "未知") + "）";
  if (effective.kind === "none") return effective.name + "（没有可用终端；会话型派单会失败）";
  return effective.name + "（" + (REASON_LABEL[effective.reason] || effective.reason) + "）";
}

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
  const effective = effectiveFor(home);
  const rows = items.map((item) => [
    item.name,
    SOURCE_LABEL[item.source] || item.source,
    item.default ? "✓" : "",
    item.name === effective.name ? "✓" : "",
    item.command || "（内置驱动）",
    item.description || "",
  ]);

  emit(
    args.options,
    {
      terminals: items,
      current: currentTerminal({ home }),
      effective: { name: effective.name, kind: effective.kind, reason: effective.reason },
    },
    () =>
      [
        table(rows, ["终端", "来源", "默认", "生效", "命令", "说明"]).replace(/[ \t]+$/gm, ""),
        "",
        "当前生效：" + describeEffective(effective),
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
  if (!name) return currentCommand(args, home);
  const result = setDefaultTerminal({ home, name });
  emit(args.options, { ok: true, ...result }, () =>
    "✓ 默认终端 = " + result.name + "（" + result.kind + "）；会话型派单会用它。");
  return 0;
}

function currentCommand(args, home) {
  const effective = effectiveFor(home);
  emit(
    args.options,
    { current: currentTerminal({ home }), effective: { name: effective.name, kind: effective.kind, reason: effective.reason } },
    "当前生效：" + describeEffective(effective),
  );
  return 0;
}
