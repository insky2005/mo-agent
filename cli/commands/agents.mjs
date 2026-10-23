import { listAgents } from "../lib/executors.mjs";
import { emit, table } from "../lib/output.mjs";

/** mo agents —— 列出内置执行者模板 */
export function agentsCommand(ctx, args) {
  const agents = listAgents();
  emit(args.options, { agents }, () =>
    table(agents.map((agent) => [agent.name, agent.requires, agent.description]), ["模板", "需要", "说明"])
    + "\n\n用法：mo task create --agent claude …\n自定义：--exec \"<命令>\"");
  return 0;
}
