/**
 * TAB 补全的候选生成。纯计算：读注册表与任务卡，不改任何东西。
 * 被 `mo __complete` 调用，由 shells 的补全脚本转给 shell。
 */
import { moHome } from "./paths.mjs";
import { listProjects, findProjectRoot } from "./project.mjs";
import { listCards } from "./store.mjs";
import { listAgents } from "./executors.mjs";
import { listCandidates } from "./candidates.mjs";

const SPEC = {
  project: { subs: ["init", "agent", "list"], flags: ["--name", "--file", "--mode", "--no-agent-file", "--remove"] },
  task: {
    subs: ["create", "confirm", "approve", "reject", "requests", "cancel", "status", "list", "dispatch", "verify", "logs"],
    flags: [
      "--title", "--deliverable", "--verify", "--boundary", "--constraint",
      "--background", "--assignee", "--worker", "--exec", "--timeout", "--wait", "--ttl", "--note", "--from", "--json",
    ],
  },
  receipt: { subs: ["submit", "apply"], flags: ["--file", "--dry-run"] },
  ledger: { subs: ["query"], flags: ["--task", "--type", "--days", "--limit", "--json"] },
  doctor: { subs: [], flags: ["--json"] },
  worker: { subs: ["list", "add", "remove"], flags: ["--command", "--description", "--requires", "--project", "--json"] },
  skill: { subs: ["install", "uninstall", "list"], flags: ["--target", "--json"] },
  completion: { subs: ["bash", "zsh"], flags: [] },
  memory: {
    subs: ["recall", "list", "init", "path", "migrate", "propose", "candidates", "accept", "reject"],
    flags: ["--limit", "--scope", "--all", "--file", "--title", "--trigger", "--tag", "--body", "--source", "--id", "--json"],
  },
  inbox: { subs: ["pull"], flags: ["--peek", "--limit", "--task", "--json"] },
  mcp: { subs: [], flags: ["--json"] },
  agent: { subs: ["describe", "add"], flags: ["--mcp", "--prompt", "--name", "--json"] },
};

const TOP_LEVEL = ["project", "task", "receipt", "ledger", "doctor", "worker", "skill", "memory", "inbox", "mcp", "agent", "completion", "help"];
const GLOBAL_FLAGS = ["--project", "--json", "--help"];
const VALUE_FLAGS = new Set([
  "--project", "--exec", "--timeout", "--file", "--task", "--name",
  "--title", "--deliverable", "--verify", "--boundary", "--constraint",
  "--background", "--assignee", "--worker", "--type", "--tail", "--days", "--limit", "--target", "--file", "--mode", "--command", "--description", "--requires", "--scope", "--peek",
  "--title", "--trigger", "--tag", "--body", "--source", "--id", "--format", "--mcp", "--name", "--from", "--dry-run",
]);

function startsWith(prefix) {
  return (item) => item.value.startsWith(prefix);
}

function item(value, description) {
  return { value, description };
}

function flagItems(flags) {
  return flags.map((flag) => item(flag, ""));
}

function taskItems(cwd) {
  const root = findProjectRoot(cwd);
  if (!root) return [];
  return listCards(root)
    .map((card) => item(card.meta.id, (card.meta.status || "") + " " + (card.meta.title || "")))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function candidateItems() {
  return listCandidates({ home: moHome() })
    .map((candidate) => item(candidate.id, candidate.scope + " " + candidate.title))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function projectItems() {
  return listProjects(moHome()).map((project) => item(project.name || project.id, project.id));
}

function valuesFor(flag, ctx) {
  if (flag === "--project") return projectItems();
  if (flag === "--task") return taskItems(ctx.cwd);
  if (flag === "--worker") return listAgents().map((agent) => item(agent.name, agent.description));
  return [];
}

/**
 * @param {{cwd?: string, words?: string[]}} ctx words 是 "mo" 之后的参数，最后一个是当前正在补的词
 * @returns {{value: string, description: string}[]}
 */
export function complete(ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const words = ctx.words || [];
  const current = words.length ? words[words.length - 1] : "";
  const tokens = words.slice(0, -1);
  const local = { cwd };

  const previous = tokens[tokens.length - 1];
  if (previous && VALUE_FLAGS.has(previous) && !current.startsWith("-")) {
    return valuesFor(previous, local).filter(startsWith(current));
  }

  if (current.startsWith("-")) {
    const group = tokens[0];
    const flags = group && SPEC[group] ? [...SPEC[group].flags, ...GLOBAL_FLAGS] : [...GLOBAL_FLAGS];
    return flagItems([...new Set(flags)]).filter(startsWith(current));
  }

  const group = tokens[0];
  if (!group) {
    return TOP_LEVEL.filter((name) => name.startsWith(current)).map((name) => item(name, ""));
  }

  const spec = SPEC[group];
  if (!spec) return [];

  const sub = tokens[1];

  // run 没有子命令，第一个位置参数就是 taskId
  if (!sub && !spec.subs.length) {
    return taskItems(cwd).filter(startsWith(current));
  }

  if (!sub) {
    return [...spec.subs.map((name) => item(name, "")), ...flagItems(GLOBAL_FLAGS)].filter(startsWith(current));
  }

  const positionals = tokens.slice(2);
  if (positionals.length > 0) return [];

  if (group === "task" && ["confirm", "approve", "reject", "cancel", "status", "dispatch", "verify"].includes(sub)) {
    return taskItems(cwd).filter(startsWith(current));
  }
  if (group === "receipt" && ["submit", "apply"].includes(sub)) return taskItems(cwd).filter(startsWith(current));
  if (group === "memory" && ["accept", "reject"].includes(sub)) return candidateItems().filter(startsWith(current));

  return [];
}

/** zsh 的 _describe 需要 "值:说明"；把值里可能出现的冒号换掉 */
export function describe(item) {
  const description = String(item.description || "").replace(/:/g, "·").replace(/\s+/g, " ").trim();
  return description ? item.value + ":" + description : item.value;
}