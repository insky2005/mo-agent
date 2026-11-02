/**
 * TAB 补全：按「组 → 子命令 → 该子命令自己的 flag」组织。
 * 纯计算，读注册表与任务卡，不改任何东西。
 */
import { moHome } from "../lib/paths.mjs";
import { listProjects, findProjectRoot } from "../lib/project.mjs";
import { listCards } from "../lib/store.mjs";
import { listAgents } from "../lib/executors.mjs";
import { listCandidates } from "../lib/candidates.mjs";
import { groupNames } from "../lib/help.mjs";
import { allTargets } from "./skill.mjs";
import { CONFIG_KEYS } from "../lib/config.mjs";

const GLOBAL_FLAGS = ["--project", "--json", "--help"];

const PROJECT = ["--project"];
const taskIds = { positional: "task" };
const candidateIds = { positional: "candidate" };
const configKeys = { positional: "configKey" };
const SETUP_STEPS = ["dirs", "config", "memory", "worker", "terminal", "skill", "mcp", "router"];
const ROUTER_RUNTIME_ACTIONS = ["install", "list", "prune"];

const SPEC = {
  task: {
    subs: {
      create: { flags: ["--title", "--deliverable", "--verify", "--boundary", "--constraint", "--background", "--assignee", "--worker", "--exec", "--timeout", "--workdir", "--from"] },
      confirm: { flags: ["--wait", "--ttl", "--from"], ...taskIds },
      approve: { flags: ["--yes", "--channel"], ...taskIds },
      reject: { flags: ["--yes", "--note", "--channel"], ...taskIds },
      requests: { flags: [] },
      cancel: { flags: [], ...taskIds },
      status: { flags: [], ...taskIds },
      list: { flags: [] },
      dispatch: { flags: ["--worker", "--exec", "--timeout"], ...taskIds },
      verify: { flags: [], ...taskIds },
      logs: { flags: ["--tail"], ...taskIds },
    },
  },
  project: {
    subs: {
      init: { flags: ["--name", "--file", "--mode", "--no-agent-file"] },
      agent: { flags: ["--file", "--mode", "--remove"] },
      list: { flags: [] },
      remove: { flags: ["--path", "--purge", "--dry-run", "--yes", "--id"] },
    },
  },
  memory: {
    subs: {
      recall: { flags: ["--limit", "--scope", "--all"] },
      list: { flags: ["--scope"] },
      init: { flags: [] },
      path: { flags: [] },
      migrate: { flags: ["--dry-run"] },
      propose: { flags: ["--file", "--scope", "--title", "--trigger", "--tag", "--body", "--source", "--task"] },
      candidates: { flags: [] },
      accept: { flags: ["--id"], ...candidateIds },
      reject: { flags: ["--id"], ...candidateIds },
    },
  },
  agent: {
    subs: {
      describe: { flags: ["--json"] },
      add: { flags: ["--mcp", "--prompt", "--name"] },
    },
  },
  watchdog: {
    subs: {
      run: { flags: ["--project", "--all", "--dry-run"] },
    },
  },
  terminal: {
    subs: {
      list: { flags: [] },
      add: { flags: ["--command", "--description", "--use"] },
      remove: { flags: [] },
      use: { flags: [] },
      current: { flags: [] },
    },
  },
  inbox: {
    subs: {
      pull: { flags: ["--peek", "--wait", "--limit", "--task"], ...taskIds },
    },
  },
  ledger: {
    subs: {
      query: { flags: ["--project", "--task", "--type", "--days", "--limit"] },
    },
  },
  receipt: {
    subs: {
      submit: { flags: ["--file", "--dry-run"], ...taskIds },
      apply: { flags: [], ...taskIds },
    },
  },
  worker: {
    subs: {
      list: { flags: [] },
      add: { flags: ["--command", "--description", "--requires", "--session", "--use", "--project"] },
      remove: { flags: [] },
      use: { flags: ["--project", "--unset"] },
      current: { flags: ["--project"] },
    },
  },
  skill: {
    subs: {
      list: { flags: ["--target"] },
      install: { flags: ["--target", "--yes"] },
      uninstall: { flags: ["--target"] },
    },
  },
  router: {
    subs: {
      start: { flags: [] },
      stop: { flags: [] },
      status: { flags: [] },
      restart: { flags: [] },
      setup: { flags: ["--provider", "--model", "--key", "--no-test"] },
      reset: { flags: [] },
      runtime: { flags: [], positional: "routerRuntimeAction" },
      help: { flags: [] },
    },
  },
  config: {
    subs: {
      list: { flags: [] },
      get: { flags: [], ...configKeys },
      set: { flags: [], ...configKeys },
      unset: { flags: [], ...configKeys },
    },
  },
  daemon: {
    subs: {
      start: { flags: ["--port", "--foreground"] },
      open: { flags: ["--browser", "--show-token"], positional: "daemonTarget" },
      install: { flags: ["--force"] },
      stop: { flags: [] },
      status: { flags: [] },
    },
  },
  setup: { subs: {} },
  upgrade: { subs: {} },
  completion: { subs: { bash: { flags: [] }, zsh: { flags: [] } } },
  mcp: { subs: {} },
  doctor: { subs: {} },
};

/** 取值型 flag：补全时给候选而不是空 */
const VALUE_FLAGS = new Set([
  "--project", "--task", "--worker", "--scope", "--mode", "--target", "--file", "--mcp", "--type", "--id", "--only", "--skip",
  "--provider", "--router-provider",
]);

const ENUMS = {
  "--scope": ["preferences", "pitfalls", "decisions"],
  "--router-provider": ["deepseek", "anthropic", "openai"],
  "--mode": ["auto", "skill", "ref", "inline"],
};

/** 没有子命令的组：自己的 flag */
const NO_SUB_FLAGS = {
  doctor: ["--json"],
  daemon: ["--port", "--foreground", "--no-apk", "--browser", "--show-token", "--json"],
  setup: [
    "--yes",
    "--dry-run",
    "--only",
    "--skip",
    "--json",
    "--router",
    "--router-provider",
    "--router-model",
    "--router-key",
    "--no-test",
  ],
  upgrade: ["--check", "--dry-run", "--version", "--force", "--json"],
};

const TOP_LEVEL = ["project", "task", "receipt", "ledger", "doctor", "worker", "skill", "memory", "inbox", "mcp", "agent", "terminal", "daemon", "router", "config", "setup", "upgrade", "watchdog", "completion", "version", "help"];

function item(value, description) {
  return { value, description };
}

function startsWith(prefix) {
  return (entry) => entry.value.startsWith(prefix);
}

function unique(values) {
  return [...new Set(values)];
}

function projectItems() {
  return listProjects(moHome()).map((project) => item(project.name || project.id, project.id));
}

function taskItems(cwd) {
  const root = findProjectRoot(cwd);
  if (!root) return [];
  return listCards(root)
    .map((card) => item(card.meta.id, (card.meta.status || "") + " " + (card.meta.title || "")))
    .sort((left, right) => left.value.localeCompare(right.value));
}

function candidateItems() {
  return listCandidates({ home: moHome() })
    .map((candidate) => item(candidate.id, candidate.scope + " " + candidate.title))
    .sort((left, right) => left.value.localeCompare(right.value));
}

function valuesFor(flag, cwd) {
  if (flag === "--project") return projectItems();
  if (flag === "--task") return taskItems(cwd);
  if (flag === "--worker") return listAgents().map((agent) => item(agent.name, agent.description));
  if (flag === "--router-provider" || flag === "--provider") {
    return (ENUMS["--router-provider"] || []).map((value) => item(value, ""));
  }
  if (flag === "--scope") return ENUMS["--scope"].map((value) => item(value, ""));
  if (flag === "--mode") return ENUMS["--mode"].map((value) => item(value, ""));
  if (flag === "--id") return candidateItems();
  if (flag === "--only" || flag === "--skip") return SETUP_STEPS.map((name) => item(name, ""));
  if (flag === "--target") {
    return allTargets()
      .filter((target) => target.available)
      .map((target) => item(target.name, target.dir));
  }
  // --file / --type 交给 shell 回退（文件名补全）
  return [];
}

function positionalFor(kind, cwd) {
  if (kind === "task") return taskItems(cwd);
  if (kind === "candidate") return candidateItems();
  if (kind === "configKey") return CONFIG_KEYS.map((spec) => item(spec.key, spec.range));
  if (kind === "routerRuntimeAction") {
    return [
      item("install", "安装私有运行时（约 150MB）"),
      item("list", "已装的版本与清单 pin"),
      item("prune", "清理旧版本"),
    ];
  }
  if (kind === "daemonTarget") {
    return [
      item("app", "安装与配对"),
      item("dingtalk", "钉钉机器人绑定"),
      item("agents", "Agent 配置"),
      item("voice", "语音"),
      item("system", "重启与日志"),
      item("monitor", "实时监控屏"),
    ];
  }
  return [];
}

/**
 * @param {{cwd?: string, words?: string[]}} ctx words 是 "mo" 之后的参数，最后一个是当前正在补的词
 */
export function complete(ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const words = ctx.words || [];
  const current = words.length ? words[words.length - 1] : "";
  const tokens = words.slice(0, -1);

  const previous = tokens[tokens.length - 1];
  if (previous && previous.startsWith("--") && !current.startsWith("-")) {
    // 取值型 flag 给具体候选；其余（--title / --body …）是自由文本，交回 shell
    return VALUE_FLAGS.has(previous) ? valuesFor(previous, cwd).filter(startsWith(current)) : [];
  }

  const group = tokens[0];

  if (!group) {
    if (current.startsWith("-")) return flagItems(GLOBAL_FLAGS, current);
    return TOP_LEVEL.filter((name) => name.startsWith(current)).map((name) => item(name, ""));
  }

  if (group === "help") {
    if (tokens[1]) return [];
    return groupNames()
      .map((name) => item(name, "看这组命令"))
      .filter((entry) => entry.value.startsWith(current));
  }

  const spec = SPEC[group];
  if (!spec) return [];

  const sub = tokens[1];

  if (!sub) {
    if (current.startsWith("-")) return flagItems([...GLOBAL_FLAGS, ...(NO_SUB_FLAGS[group] || [])], current);
    const subs = Object.keys(spec.subs);
    // mcp / doctor 没有子命令：直接给 flag
    if (!subs.length) return flagItems([...GLOBAL_FLAGS, ...(NO_SUB_FLAGS[group] || [])], current);
    return [...subs.map((name) => item(name, "")), item("help", "看这组命令"), ...flagItems(GLOBAL_FLAGS, current)].filter(
      startsWith(current),
    );
  }

  const subSpec = spec.subs[sub];
  if (!subSpec) return [];

  const typed = tokens.slice(2);
  const flags = unique([...subSpec.flags, ...GLOBAL_FLAGS]);

  if (current.startsWith("-")) return flagItems(flags, current);

  // 第一个位置参数：优先给具体 id；没有就退回 flag
  if (typed.length === 0 && subSpec.positional) {
    const items = positionalFor(subSpec.positional, cwd);
    if (items.length) return items.filter(startsWith(current));
  }

  // 其余位置参数没有候选；给 flag 提示比什么都不给好
  return flagItems(flags, current);
}

/** flag 的说明，补全时一起显示；没列到的给空串 */
const FLAG_DESC = {
  "--browser": "用普通浏览器打开（带地址栏）",
  "--show-token": "链接里显示完整令牌",
  "--port": "端口号，默认 7788",
  "--foreground": "前台运行，Ctrl+C 停",
  "--json": "机器可读输出",
  "--help": "看这一组的用法",
  "--project": "指定项目",
  "--yes": "跳过确认",
  "--dry-run": "只预演，不落盘",
  "--only": "只跑指定步骤",
  "--skip": "跳过指定步骤",
  "--router": "也配置指挥台（装运行时 + 配模型凭据）",
  "--router-provider": "指挥台的 provider",
  "--router-model": "指挥台的模型 id",
  "--router-key": "指挥台的 API key（落 credentials.json，0600）",
  "--no-test": "跳过测通",
  "--provider": "指挥台的 provider",
  "--model": "指挥台的模型 id",
  "--key": "指挥台的 API key",
  "--force": "强制重装运行时",
  "--no-apk": "跳过 APK 预下载",
};

function flagItems(flags, current) {
  return unique(flags).map((flag) => item(flag, FLAG_DESC[flag] || "")).filter(startsWith(current));
}

/** zsh 的 _describe 需要 "值:说明"；把值里可能出现的冒号换掉 */
export function describe(entry) {
  const description = String(entry.description || "").replace(/:/g, "·").replace(/\s+/g, " ").trim();
  return description ? entry.value + ":" + description : entry.value;
}