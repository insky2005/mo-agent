import { listAgents } from "../lib/executors.mjs";
import { emit, table } from "../lib/output.mjs";

/** mo agents —— 列出内置执行者模板及其完整命令 */
export function agentsCommand(ctx, args) {
  const agents = listAgents();
  emit(args.options, { agents }, () =>
    table(
      agents.map((agent) => [agent.name, agent.command, agent.description]),
      ["模板", "命令", "说明"],
    )
    + "\n\n用法：mo task create --agent claude …\n"
    + "自定义：--exec \"<命令>\"（与 --agent 互斥）",
  );
  return 0;
}
