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
      ["create", "建卡（draft）", '例：--title "…" --deliverable "…" --verify "run:npm test" --workdir app/web'],
      ["confirm <id>", "发起确认请求：只写 approvals/，卡保持 draft", "任何 Agent 都能做，不改状态"],
      ["approve <id>", "人批准：需 TTY，校验卡片指纹", "y 批准 / n 拒绝 / 回车取消"],
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
      ["remove [名称|路径]", "从本机注册表移除；默认不碰仓库文件", "加 --purge 才删 .mo-agent/"],
    ],
  },
  {
    name: "worker",
    title: "执行者",
    subs: [
      ["list", "内置与自定义执行者，含本机是否安装", "末行显示默认执行者"],
      ["add", "注册自定义执行者", "--use 顺便设为默认"],
      ["remove", "删除自定义执行者", ""],
      ["use [名]", "设置默认执行者（assignee: auto 用它）", "--unset 清除"],
      ["current", "打印当前默认执行者", ""],
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
    name: "inbox",
    title: "收件箱",
    subs: [["pull", "拉任务通知（done / blocked / failed），拉完归档", "没有就等，见 --wait"]],
  },
  {
    name: "terminal",
    title: "终端",
    blurb: "会话型 worker 派单时用哪个终端开窗口",
    subs: [
      ["list", "内置与自定义终端", "带默认标记"],
      ["add <名> --command '<模板>'", "注册自定义终端", "{script} 会替换成脚本路径"],
      ["remove <名>", "删除自定义终端", ""],
      ["use [名]", "设置默认终端；不带名字就打印当前", ""],
      ["current", "打印当前生效的终端与原因", "没设默认时显示自动探测结果"],
    ],
  },
  {
    name: "daemon",
    title: "常驻服务",
    blurb: "拉起 host（桌面 App 里那个服务），手机扫码配对、下载 APK",
    subs: [
      ["start [--port N] [--foreground]", "后台启动 host；--foreground 前台跑，Ctrl+C 停", "顺手下载 APK 到 ~/.mo-agent/app.apk"],
      ["stop", "停止 daemon", ""],
      ["status", "是否在跑、健康检查、APK 是否就绪", "默认子命令"],
    ],
  },
  {
    name: "config",
    title: "全局配置",
    blurb: "~/.mo-agent/config.json：只放全局、机器级的键（端口、日志、召回条数…）",
    subs: [
      ["list", "所有键：值 + 来源", "来源为 默认 / config.json / 环境变量"],
      ["get <键>", "打印一个键的生效值", ""],
      ["set <键> <值>", "写进 config.json", "校验类型与范围"],
      ["unset <键>", "删掉该键，回到默认", ""],
    ],
  },
  {
    name: "setup",
    title: "首次装配",
    blurb: "幂等：已存在的步骤跳过；不碰仓库、不启动 daemon",
    subs: [
      ["", "交互式装配；非 TTY 等同 --yes", "可改根目录与全局配置，选执行者/终端/技能/MCP"],
      ["--dry-run", "只报告；逐步预览，绝不写文件", ""],
      ["--only 步骤 / --skip 步骤", "只做 / 不做某些步骤", "dirs config memory worker terminal skill mcp"],
      ["--json", "每步的 status 与汇总", ""],
    ],
  },
  {
    name: "watchdog",
    title: "看门狗",
    blurb: "把超时没回执的卡转成 blocked(timeout)，并落收件箱",
    subs: [
      ["run", "扫一遍当前项目", "可挂 cron / launchd"],
      ["run --all", "扫全部已登记项目", ""],
      ["run --dry-run", "只报告，不改状态", ""],
    ],
  },
  {
    name: "mcp",
    title: "MCP",
    subs: [["", "stdio MCP 服务，一行一条 JSON-RPC", "给支持 MCP 的 Agent 当后端"]],
  },
];

/** 每个组的选项。help 只做索引，具体语义仍由命令负责。 */
const OPTIONS = {
  task: [
    ["--title <标题> --deliverable <产出>", "create 必填，产出可重复"],
    ["--verify run:|check:|human:", "验收项，可重复；缺了会警告 W_NO_VERIFY"],
    ["--boundary / --constraint / --background", "写进卡的正文段落，可重复"],
    ["--worker <名> | --exec <命令>", "执行者，二选一"],
    ["--timeout 45m", "执行超时（默认 45m）"],
    ["--workdir <相对路径>", "执行目录：相对项目根解析（默认项目根，不是 shell 当前目录）"],
    ["--assignee auto|<名>", "建卡时记下意向执行者"],
    ["--from <id>", "这张卡是谁派的（缺省取 MO_AGENT_ID）"],
    ["--wait 60s / --ttl 24h", "confirm：等批准 / 请求有效期"],
    ["--yes / --note <说明>", "approve | reject：非 TTY 的显式逃生口与备注"],
    ["--channel <名>", "approve | reject：记进账本的批准通道（terminal / web / mcp-elicitation）"],
    ["--tail 50", "logs：只看最后 N 行"],
  ],
  project: [
    ["--mode auto|skill|ref|inline", "init / agent：写 AGENTS.md 的方式，默认 auto"],
    ["--no-agent-file", "init：只认领项目，不碰 AGENTS.md"],
    ["--file <路径>", "指定 AGENTS.md / CLAUDE.md，默认自动找一个"],
    ["--name <名称>", "init：项目名，默认目录名"],
    ["--remove", "agent：删掉 mo 写的那一段"],
    ["--path <路径>", "remove：只移除这一个登记位置"],
    ["--purge", "remove：连 <repo>/.mo-agent/ 一起删（需确认）"],
    ["--dry-run", "remove：只打印计划，不动手"],
    ["--yes", "remove：非 TTY 下跳过确认（谨慎）"],
  ],
  memory: [
    ["--scope preferences|pitfalls|decisions", "recall / list / propose：限定范围"],
    ["--limit N / --all", "recall：条数上限 / 不截断"],
    ["--file - | --title --trigger --body", "propose：从 stdin 读 JSON，或直接给字段"],
    ["--tag <词> --source <来源> --task <id>", "propose：补充元数据"],
    ["--dry-run", "migrate：只打印要搬什么"],
    ["--id <候选 id>", "accept / reject 的另一种写法"],
  ],
  agent: [
    ["--json", "describe：机器可读的契约"],
    ["--mcp <配置文件>", "add：合并 mcpServers，幂等 + 备份"],
    ["--name <服务名>", "add：写进配置的服务名，默认 mo"],
    ["--prompt", "add：只打印可粘贴的提示词"],
  ],
  inbox: [
    ["--wait 60s", "没有消息就等到超时，有就立刻返回"],
    ["--peek", "只看，不归档"],
    ["--task <id> / --limit N", "只拉某条 / 限制条数"],
  ],
  ledger: [
    ["--project <名称|路径>", "按项目过滤"],
    ["--task <id>", "按任务过滤"],
    ["--type task.", "按事件类型前缀过滤"],
    ["--days 30 / --limit 50", "时间窗与条数"],
  ],
  receipt: [
    ["--file -", "submit：从 stdin 读回执 JSON"],
    ["--dry-run", "submit：只校验，不写盘"],
  ],
  worker: [
    ["--command <命令>", "add：这个执行者怎么启动"],
    ["--session", "add：会话型——派单时开新终端窗口跑交互式 CLI"],
    ["--use", "add：注册的同时设为默认执行者"],
    ["--description <说明> --requires <能力>", "add：给人看的说明与能力要求"],
    ["--project <名称|路径>", "add：只在某个项目里可用"],
  ],
  skill: [
    ["--target <名|路径>", "指定要装到哪，默认探测已安装的 Agent"],
    ["--yes", "install：跳过交互，装到全部可用目标"],
  ],
  config: [
    ["--json", "list / get：机器可读输出"],
  ],
  setup: [
    ["--yes", "不问，取默认（非 TTY 也是这个行为）"],
    ["--dry-run", "只检查、只报告，不写任何文件（不会执行）"],
    ["--only memory,mcp", "只跑这些步骤"],
    ["--skip skill", "跳过这些步骤"],
    ["--json", "机器可读：每步 status / doctor / remaining"],
  ],
};

const EXTRA = [
  ["doctor", "自检：Node、目录、记忆库、项目", ""],
  ["completion bash|zsh", "输出补全脚本（eval 即可）", ""],
  ["help [组]", "本帮助；给个组名看该组子命令", "例如 mo help task"],
];

/** 中文占两列，按显示宽度补空格才对齐 */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += WIDE.test(char) ? 2 : 1;
  return width;
}

function padDisplay(text, target) {
  return text + " ".repeat(Math.max(2, target - displayWidth(text)));
}

function subLine(name, desc, note) {
  return padDisplay("  mo " + name, 40) + desc + (note ? "  · " + note : "");
}

export function renderHelp() {
  const row = (left, right) => padDisplay(left, 40) + right;
  const lines = [
    "mo —— 个人工作台：想法 → 任务卡 → 人批准 → 派单 → 按账本汇报",
    "",
    "第一次用",
    row("  mo setup", "首次装配（幂等；不碰仓库）"),
    row("  mo doctor", "自检（Node / 目录 / 记忆库 / 项目）"),
    row("  mo agent", "接一个 Agent 时看这个"),
    row("  mo config list", "全局配置：值 + 来源（set / unset 改）"),
    row("  mo help <组>", "某组的子命令与选项（--mode、--wait 这些）"),
    "",
    "一个新项目",
    row("  mo project init [路径]", "认领目录（默认当前目录），写 .mo-agent/ 与 AGENTS.md"),
    "",
    "一个新任务",
    row("  mo task create --title … --deliverable … --verify … --workdir …", "建卡（draft）"),
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

    const options = OPTIONS[group.name] || [];
    if (options.length) {
      lines.push("", "  选项");
      for (const [flag, desc] of options) lines.push("  " + padDisplay(flag, 38) + desc);
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