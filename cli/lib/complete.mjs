/**
 * TAB 补全：按「组 → 子命令 → 该子命令自己的 flag」组织。
 * 纯计算，读注册表与任务卡，不改任何东西。
 */
import { moHome } from "./paths.mjs";
import { listProjects, findProjectRoot } from "./project.mjs";
import { listCards } from "./store.mjs";
import { listAgents } from "./executors.mjs";
import { listCandidates } from "./candidates.mjs";
import { groupNames } from "./help.mjs";
import { allTargets } from "../commands/skill.mjs";

const GLOBAL_FLAGS = ["--project", "--json", "--help"];

const PROJECT = ["--project"];
const taskIds = { positional: "task" };
const candidateIds = { positional: "candidate" };

const SPEC = {
  task: {
    subs: {
      create: { flags: ["--title", "--deliverable", "--verify", "--boundary", "--constraint", "--background", "--assignee", "--worker", "--exec", "--timeout", "--from"] },
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
      add: { flags: ["--command", "--description", "--requires", "--project"] },
      remove: { flags: [] },
    },
  },
  skill: {
    subs: {
      list: { flags: ["--target"] },
      install: { flags: ["--target", "--yes"] },
      uninstall: { flags: ["--target"] },
    },
  },
  completion: { subs: { bash: { flags: [] }, zsh: { flags: [] } } },
  mcp: { subs: {} },
  doctor: { subs: {} },
};

/** 取值型 flag：补全时给候选而不是空 */
const VALUE_FLAGS = new Set([
  "--project", "--task", "--worker", "--scope", "--mode", "--target", "--file", "--mcp", "--type", "--id",
]);

const ENUMS = {
  "--scope": ["preferences", "pitfalls", "decisions"],
  "--mode": ["auto", "skill", "ref", "inline"],
};

const TOP_LEVEL = ["project", "task", "receipt", "ledger", "doctor", "worker", "skill", "memory", "inbox", "mcp", "agent", "completion", "version", "help"];

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
  if (flag === "--scope") return ENUMS["--scope"].map((value) => item(value, ""));
  if (flag === "--mode") return ENUMS["--mode"].map((value) => item(value, ""));
  if (flag === "--id") return candidateItems();
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
    if (current.startsWith("-")) return flagItems(GLOBAL_FLAGS, current);
    const subs = Object.keys(spec.subs);
    // mcp / doctor 没有子命令：直接给 flag
    if (!subs.length) return flagItems([...GLOBAL_FLAGS, ...(group === "doctor" ? ["--json"] : [])], current);
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

function flagItems(flags, current) {
  return unique(flags).map((flag) => item(flag, "")).filter(startsWith(current));
}

/** zsh 的 _describe 需要 "值:说明"；把值里可能出现的冒号换掉 */
export function describe(entry) {
  const description = String(entry.description || "").replace(/:/g, "·").replace(/\s+/g, " ").trim();
  return description ? entry.value + ":" + description : entry.value;
}
