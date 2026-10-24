/**
 * mo help 的内容源。分组、按组查看，避免把所有子命令拍成一长串。
 * 只描述"怎么用"，具体行为由各命令自己保证。
 */

export const GROUPS = [
  {
    name: "task",
    title: "任务卡",
    blurb: "建卡 → 发起确认请求 → 人批准 → 派单 → 看结果",
    subs: [
      ["create", "建卡（draft）", '例：--title "…" --deliverable "…" --verify "run:npm test"'],
      ["confirm <id>", "发起确认请求：只写 approvals/，卡保持 draft", "任何 Agent 都能做，不改状态"],
      ["approve <id>", "人批准：需 TTY，校验卡片指纹", "批准前改卡会作废（E_CARD_CHANGED）"],
      ["reject <id>", "人拒绝，卡保持 draft", ""],
      ["requests", "待批准的请求", "顺带把过期请求标掉"],
      ["dispatch <id>", "派单并等待验收", "前台阻塞，可能几分钟"],
      ["status <id>", "状态、验收、待批请求", ""],
      ["list", "本项目全部任务", ""],
      ["cancel <id>", "取消", ""],
      ["verify <id>", "对已 done 的卡重跑验收", "只改 verified 与账本"],
      ["logs <id> [--tail N]", "执行者完整日志", ""],
    ],
  },
  {
    name: "memory",
    title: "记忆",
    blurb: "派单时按卡片内容召回并注入；候选要人裁决才入库",
    subs: [
      ["init", "建骨架（幂等）", ""],
      ["list", "列出条目", ""],
      ["recall \"关键词\"", "召回（派单时自动带上同一批）", ""],
      ["path", "打印记忆库位置", ""],
      ["migrate", "把旧的 knowledge/ 搬到 memory/", "不合并、不覆盖"],
      ["propose --file -", "提一条候选", "缺 trigger 会被拒收"],
      ["candidates", "看待裁决的候选", ""],
      ["accept|reject <id>", "采纳 / 丢弃候选", "accept 遇冲突会拒写"],
    ],
  },
  {
    name: "agent",
    title: "接入主 Agent",
    blurb: "mo 不认识任何具体 Agent，只产出可粘贴物",
    subs: [
      ["describe", "怎么接：能做什么、三种接法", "默认就是概览"],
      ["describe --json", "机器可读的契约", ""],
      ["add --prompt", "打印可粘贴的提示词", "给只会聊天的 Agent"],
      ["add --mcp <file>", "合并 mcpServers 配置", "幂等 + 备份"],
    ],
  },
  {
    name: "project",
    title: "项目",
    subs: [
      ["init [路径]", "认领项目，写 .mo-agent/ 与 AGENTS.md", ""],
      ["agent [--remove]", "只写/删 AGENTS.md、CLAUDE.md 那段", ""],
      ["list", "已登记项目", ""],
    ],
  },
  {
    name: "worker",
    title: "执行者",
    subs: [
      ["list", "内置与自定义执行者，含本机是否安装", ""],
      ["add", "注册自定义执行者", ""],
      ["remove", "删除自定义执行者", ""],
    ],
  },
  {
    name: "ledger",
    title: "账本",
    subs: [["query", "按项目 / 任务 / 类型 / 天数查事件", "机器事实，汇报以它为准"]],
  },
  {
    name: "receipt",
    title: "回执",
    subs: [
      ["submit <id> --file -", "手工写入回执（不改状态）", ""],
      ["apply <id>", "应用已有回执：跑验收并改状态", ""],
    ],
  },
  {
    name: "skill",
    title: "技能",
    subs: [
      ["list", "各 Agent 技能目录的安装情况", ""],
      ["install", "装 mo 技能到技能目录", "内容由 contract 生成"],
      ["uninstall", "卸载", ""],
    ],
  },
  {
    name: "mcp",
    title: "MCP",
    subs: [["", "stdio MCP 服务，一行一条 JSON-RPC", "给支持 MCP 的 Agent 当后端"]],
  },
];

const EXTRA = [
  ["doctor", "自检：Node、目录、记忆库、项目", ""],
  ["completion bash|zsh", "输出补全脚本（eval 即可）", ""],
  ["help [组]", "本帮助；给个组名看该组子命令", "例如 mo help task"],
];

function subLine(name, desc, note) {
  const left = "  mo " + name;
  const pad = Math.max(2, 40 - left.length);
  return left + " ".repeat(pad) + desc + (note ? "  · " + note : "");
}

export function renderHelp() {
  const row = (left, right) => left + " ".repeat(Math.max(2, 40 - left.length)) + right;
  const lines = [
    "mo —— 个人工作台：想法 → 任务卡 → 人批准 → 派单 → 按账本汇报",
    "",
    "第一次用",
    row("  mo doctor", "自检（Node / 目录 / 记忆库 / 项目）"),
    row("  mo project init [路径]", "认领当前目录，写 AGENTS.md"),
    row("  mo agent", "接一个 Agent 时看这个"),
    "",
    "一次派活",
    row("  mo task create --title … --deliverable … --verify …", "建卡（draft）"),
    row("  mo task confirm <id>", "发起确认请求（Agent 可做，不改状态）"),
    row("  mo task approve <id>", "人批准（需 TTY，校验卡片指纹）"),
    row("  mo task dispatch <id>", "派单并等待验收"),
    row("  mo task status <id>", "状态、验收、待批请求"),
    row("  mo inbox pull [--wait 60s]", "拉任务通知（没有就等）"),
    "",
    "全部子命令",
  ];

  for (const group of GROUPS) {
    const names = [...new Set(group.subs.map(([sub]) => sub.split(" ")[0]).filter(Boolean))];
    const right = names.length ? names.join(" ") : (group.blurb || "stdio 服务，给支持 MCP 的 Agent");
    lines.push("  " + group.name.padEnd(10) + right);
  }

  lines.push(
    "",
    "  子命令说明  mo help <组>     例如 mo help task",
    "",
    "全局选项    --project <名称|路径>   --json",
    "环境变量    MO_AGENT_HOME（默认 ~/.mo-agent）  MO_AGENT_MEMORY  MO_RECALL_LIMIT",
  );

  return lines.join("\n");
}

export function renderGroupHelp(name) {
  const group = GROUPS.find((item) => item.name === name);
  if (group) {
    const lines = ["mo " + group.name + " —— " + group.title];
    if (group.blurb) lines.push("", "  " + group.blurb);
    lines.push("");
    for (const [sub, desc, note] of group.subs) {
      lines.push(subLine((group.name + " " + sub).trim(), desc, note));
    }
    lines.push("", "全部命令：mo help");
    return lines.join("\n");
  }

  const extra = EXTRA.find(([name_]) => name_.split(" ")[0] === name);
  if (extra) return "  mo " + extra[0] + "\n    " + extra[1] + (extra[2] ? "  · " + extra[2] : "");

  return null;
}

/** mo help 能接的话题：分组 + 单命令（doctor / completion / help） */
export function groupNames() {
  return [...GROUPS.map((group) => group.name), ...EXTRA.map(([label]) => label.split(" ")[0])];
}
