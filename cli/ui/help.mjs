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
      ["create", "建骨架（幂等）", "旧名 init 仍可用，将移除"],
      ["list", "列出条目", ""],
      ["recall \"关键词\"", "召回（派单时自动带上同一批）", ""],
      ["path", "打印记忆库位置", ""],
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
      ["project [--remove]", "写/删项目里的 Agent 说明段（原 mo project agent）", ""],
    ],
  },
  {
    name: "project",
    title: "项目",
    subs: [
      ["create [路径]", "认领项目，写 .mo-agent/ 与 AGENTS.md", "旧名 init / add 仍可用"],
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
      ["use [名]", "设置默认执行者（assignee: auto 用它）", "不带名字 = 打印当前默认（旧名 current 将移除）"],
    ],
  },
  {
    name: "ledger",
    title: "账本",
    subs: [["query", "按项目 / 任务 / 类型 / 天数查事件", "机器事实，汇报以它为准"]],
  },
  {
    name: "serve",
    title: "常驻服务",
    blurb: "手机、钉钉、监控屏与指挥台都靠它；router 是它的一个形态",
    subs: [
      ["start [--port N] [--foreground]", "后台启动 host；--foreground 前台跑", "顺手下载 APK（--no-apk 跳过）"],
      ["stop", "停止（只停 mo 拉起的）", "桌面 App 拉起时拒绝，返回码 2"],
      ["restart", "停止后再启动", "停不掉也继续，start 是幂等的"],
      ["status", "在不在跑、健康检查、APK 是否就绪", "默认子命令"],
      ["open [app|dingtalk|agents|voice|system|monitor]", "打开设置页页签或监控屏（自动带令牌）", "默认 monitor"],
      ["router <子命令>", "指挥台：serve router start|stop|status|setup|runtime", "等价于 mo router"],
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
      ["use [名]", "设置默认终端；不带名字就打印当前", "没设默认时显示自动探测结果（旧名 current 将移除）"],
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
    name: "upgrade",
    title: "升级",
    blurb: "查 GitHub Releases 上的最新 CLI；只有单文件二进制会自替换",
    subs: [["", "检查并升级（已是最新就什么都不做）", "默认子命令"]],
  },
  {
    name: "router",
    title: "指挥台",
    blurb: "mo 自己的主 Agent：常驻、只做分派，不碰项目工作区",
    subs: [
      ["", "启动指挥台（等同 start）", "默认子命令"],
      ["start [--window] [--start-daemon]", "启动指挥台：默认就在当前终端跑", "--start-daemon 先起 host 并打开监控屏；--window 开新窗口"],
      ["stop", "停止", ""],
      ["status", "看状态：跑没跑、用哪个模型、工作台在哪", "未运行退出码 1"],
      ["restart", "重启", ""],
      ["setup --provider --key", "配置模型与凭据（0600 落盘）", "默认会测通；--no-test 跳过"],
      ["reset", "删除 Router 的凭据", ""],
      ["runtime install|list|prune", "安装/查看/清理私有运行时", "版本 pin 在 runtimes.json"],
    ],
  },
  {
    name: "internal",
    title: "内部命令",
    blurb: "机器用 / 排障用；日常不需要碰",
    subs: [
      ["mcp", "stdio MCP 服务（给支持 MCP 的 Agent 当后端）", "Agent 配置里仍然写 mo mcp"],
      ["receipt submit|apply <id>", "手工写回执 / 应用已有回执", "回执属于执行者，正常情况不用手写"],
      ["watchdog run [--all] [--dry-run]", "把超时没回执的卡转成 blocked(timeout)", "可挂 cron / launchd"],
      ["completion bash|zsh", "输出补全脚本（eval 即可）", ""],
      ["memory-migrate [--dry-run]", "把旧的 knowledge/ 搬到 memory/（原 mo memory migrate）", "不合并、不覆盖"],
      ["note-write --file -", "记一篇过程文档（MCP note_write 的 CLI 说法）", "不接受路径；同日同名自动加 -2"],
    ],
  },
];

/** 旧名字 → 新分组（E1–E5 的别名过渡）：mo help <旧名> 也能看到该看的东西 */
const ALIASES = {
  connect: "agent",
  daemon: "serve",
  receipt: "internal",
  watchdog: "internal",
  mcp: "internal",
  completion: "internal",
};

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
    ["--force", "dispatch：卡在 running 时强制再派一次（默认拒绝，避免两个执行者抢同一份回执）"],
    ["--detach", "dispatch：后台跑，立即返回；结果用 mo inbox pull 收"],
    ["--no-prompt", "create：TTY 下不要问「现在批准并派单吗」（脚本里本来就不问）"],
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
  upgrade: [
    ["--check", "只检测，不下载、不替换（会刷新本地缓存）"],
    ["--dry-run", "只打印要下载哪个资产、替换哪个文件"],
    ["--version <标签|版本>", "装指定版本，如 cli-v0.3.0 或 0.3.0；降级要配合 --force"],
    ["--force", "同版本也重装；降级时必须加"],
    ["--json", "机器可读：current / latest / updateAvailable / tag"],
  ],
  setup: [
    ["--yes", "不问，取默认（非 TTY 也是这个行为）"],
    ["--dry-run", "只检查、只报告，不写任何文件（不会执行）"],
    ["--only memory,mcp", "只跑这些步骤"],
    ["--skip skill", "跳过这些步骤"],
    ["--json", "机器可读：每步 status / doctor / remaining"],
    ["--router", "也配置指挥台：装运行时 + 配模型凭据", "非交互时必须显式加；会下载约 150MB"],
    ["--router-provider deepseek", "指挥台的 provider", "deepseek / anthropic / openai"],
    ["--router-model <id>", "指挥台的模型", "缺省 deepseek-flash"],
    ["--router-key <key>", "指挥台凭据；也可用环境变量", "落 credentials.json（0600）"],
    ["--no-test", "跳过测通", ""],
  ],
};

const EXTRA = [
  ["doctor", "自检：Node、目录、记忆库、项目", ""],
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

/**
 * 默认第一屏：只给一条主路径，不给目录。
 * 全量分组用 mo help --all（见 renderHelpAll）。
 */
export function renderHelp() {
  const row = (left, right) => padDisplay(left, 34) + right;
  return [
    "mo —— 想法 → 任务卡 → 人批准 → 派单 → 验收 → 账本",
    "",
    row("  mo setup", "装配（幂等；不碰仓库）"),
    row("  mo doctor", "自检；最后一行永远是“下一步”"),
    row("  mo task create …", "建卡（TTY 下可一并批准并派单）"),
    row("  mo task show <id>", "状态 / 验收 / 待批 / 结论"),
    row("  mo inbox pull", "等结果（done / blocked / failed）"),
    row("  mo serve start", "常驻服务：手机、钉钉、监控屏"),
    row("  mo connect describe", "接入外部 Agent（技能 + MCP）"),
    "",
    "全部分组：mo help --all　　某组细节：mo help <组>",
  ].join("\n");
}

export function renderHelpAll() {
  const row = (left, right) => padDisplay(left, 40) + right;
  const lines = [
    "mo —— 个人工作台：想法 → 任务卡 → 人批准 → 派单 → 按账本汇报",
    "",
    "第一次用",
    row("  mo setup", "首次装配（幂等；不碰仓库）"),
    row("  mo doctor", "自检（Node / 目录 / 记忆库 / 项目）"),
    row("  mo upgrade --check", "看有没有新版（mo upgrade 直接升级）"),
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
  const group = GROUPS.find((item) => item.name === (ALIASES[name] || name));
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
  return [...new Set([
    ...GROUPS.map((group) => group.name),
    ...Object.keys(ALIASES),
    ...EXTRA.map(([label]) => label.split(" ")[0]),
  ])];
}