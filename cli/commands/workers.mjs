import { listAgents } from "../lib/executors.mjs";
import { emit, table } from "../lib/output.mjs";

/** mo workers —— 列出内置执行者模板、完整命令与本机是否安装 */
export function workersCommand(ctx, args) {
  const agents = listAgents();
  emit(args.options, { agents }, () => {
    const rows = agents.map((agent) => [
      agent.name,
      agent.installed ? "✓" : "✗",
      agent.command,
      agent.description,
    ]);
    const missing = agents.filter((agent) => !agent.installed).map((agent) => agent.requires);
    const lines = [
      table(rows, ["模板", "已装", "命令", "说明"]),
      "",
      "用法：mo task create --agent claude …",
      '自定义：--exec "<命令>"（与 --agent 互斥）',
    ];
    if (missing.length) {
      lines.push("未安装：" + [...new Set(missing)].join(" / ") + "（先装好再选对应模板）");
    }
    return lines.join("\n");
  });
  return 0;
}