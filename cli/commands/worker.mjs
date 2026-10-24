import { listAgents } from "../lib/executors.mjs";
import { emit, table } from "../lib/output.mjs";

/** mo worker list —— 列出可用的执行者模板、完整命令与本机是否安装 */
export function workerCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  if (sub !== "list") {
    throw new Error("未知子命令：worker " + sub + "（可用：list）");
  }
  const agents = listAgents();
  emit(args.options, { agents }, () => {
    const rows = agents.map((agent) => [
      agent.name,
      agent.installed ? "✓" : "✗ 缺 " + agent.missing.map((item) => item.split("/").pop()).join(", "),
      agent.command,
      agent.description,
    ]);
    const missing = agents.filter((agent) => !agent.installed).flatMap((agent) => agent.missing.map((item) => item.split("/").pop()));
    const lines = [
      table(rows, ["模板", "已装", "命令", "说明"]),
      "",
      "用法：mo task create --agent claude …",
      '自定义：--exec "<命令>"（与 --agent 互斥）',
    ];
    if (missing.length) {
      lines.push("不可用：" + [...new Set(missing)].join(" / ") + "（对应模板选不了）");
    }
    return lines.join("\n");
  });
  return 0;
}