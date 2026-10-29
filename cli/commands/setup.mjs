import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { MoError } from "../../core/errors.mjs";
import { all, has } from "../lib/args.mjs";
import { emit, isJson } from "../lib/output.mjs";
import { ledgerDir, moHome } from "../lib/paths.mjs";
import { ensureDir } from "../lib/fsx.mjs";
import {
  CONFIG_KEYS,
  configFile,
  configKey,
  effectiveConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "../lib/config.mjs";
import { SKILL_NAME } from "../lib/skill-content.mjs";
import { initMemory } from "./memory.mjs";
import { allTargets, chooseTargets, installSkillTargets, resolveTargets } from "./skill.mjs";
import { mergeMcpConfig } from "./agent-add.mjs";
import { defaultWorkerName, listWorkers, setDefaultWorker } from "../lib/workers-config.mjs";
import {
  currentTerminal,
  detectTerminal,
  listTerminals,
  setDefaultTerminal,
  terminalByName,
  terminalsFile,
} from "../lib/terminals.mjs";
import { doctorReport } from "./doctor.mjs";

/**
 * mo setup —— 首次装配，幂等。
 *
 * 只串已有命令/函数，不重写逻辑；绝不碰仓库（不建 project.json、不写
 * <repo>/.mo-agent/、不改 AGENTS.md），也不启动 daemon。
 *
 * 交互（TTY + 没给 --yes）时可以改数据目录根目录、逐键改全局配置、选默认
 * 执行者/终端/技能目标，并确认 MCP；--dry-run 交互时先走一遍这些选择，
 * 最后问"按这个计划真实执行吗"。
 */

const STATUS_ICON = { created: "✓", skipped: "⏭", planned: "·", warn: "⚠", failed: "✗" };

const SOURCE_LABEL = { default: "默认", file: "config.json", env: "环境变量（会覆盖文件）" };

const REMEDY = {
  home: "mo setup",
  ledger: "建一张卡，或再跑一次 mo setup",
  memory: "mo memory init",
  projects: "mo project init <仓库>",
  "cwd-project": "mo project init .",
};

function result(status, message, detail, lines) {
  return {
    status,
    message,
    ...(detail === undefined ? {} : { detail }),
    ...(lines && lines.length ? { lines } : {}),
  };
}

const created = (message, detail, lines) => result("created", message, detail, lines);
const skipped = (message, detail) => result("skipped", message, detail);
const planned = (message, detail, lines) => result("planned", message, detail, lines);
const warning = (message, detail, lines) => result("warn", message, detail, lines);
const failed = (message, detail, lines) => result("failed", message, detail, lines);

function makePrompter() {
  let rl = null;
  const open = () => (rl ||= readline.createInterface({ input: process.stdin, output: process.stdout }));
  return {
    async ask(question) {
      return String(await open().question(question)).trim();
    },
    close() {
      if (rl) {
        rl.close();
        rl = null;
      }
    },
  };
}

async function chooseWorker(installed, prompter) {
  const lines = ["选一个默认执行者（assignee: auto 的卡会用它）：", ""];
  installed.forEach((worker, index) => {
    lines.push("  " + (index + 1) + ") " + worker.name.padEnd(18) + (worker.session ? "会话" : "无头") + "  " + (worker.description || ""));
  });
  lines.push("", "回车：用第 1 个 | 编号：选它 | q：跳过");
  process.stdout.write(lines.join("\n") + "\n");
  const answer = (await prompter.ask("> ")).toLowerCase();
  if (answer === "q") return null;
  if (answer === "") return installed[0];
  const pick = Number(answer);
  return Number.isInteger(pick) && pick >= 1 && pick <= installed.length ? installed[pick - 1] : installed[0];
}

function expandPath(input) {
  const text = String(input || "").trim();
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

async function chooseRoot(ctx, fallback) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await ctx.prompter.ask("数据目录根目录（回车=" + fallback + "，可输入其它路径，q 跳过）：");
    if (answer.toLowerCase() === "q") return null;
    const dir = path.resolve(expandPath(answer || fallback));
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
      process.stderr.write("[W_HOME] 不是目录：" + dir + "\n");
      continue;
    }
    return dir;
  }
  return fallback;
}

function configValueLines(ctx) {
  const effective = effectiveConfig({ home: ctx.home });
  return CONFIG_KEYS.map((spec) => {
    const item = effective[spec.key];
    const shown = item.value === "" ? "（空=默认目录）" : String(item.value);
    return "  " + spec.key.padEnd(14) + "= " + shown + "  · " + (SOURCE_LABEL[item.source] || item.source);
  });
}

function parseConfigEdits(answer) {
  const edits = {};
  for (const token of String(answer).split(/[,，\s]+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      process.stderr.write("[W_CONFIG] 忽略输入：" + token + "（需要 key=value）\n");
      continue;
    }
    const key = token.slice(0, eq).trim();
    const raw = token.slice(eq + 1).trim();
    const spec = configKey(key);
    if (!spec) {
      process.stderr.write("[W_CONFIG] 未知键：" + key + "（mo config list 查看）\n");
      continue;
    }
    const parsed = spec.parse(raw);
    if (!parsed.ok) {
      process.stderr.write("[W_CONFIG] 非法值：" + key + "=" + raw + "（" + parsed.message + "）\n");
      continue;
    }
    edits[key] = parsed.value;
  }
  return edits;
}

async function chooseTerminal(ctx, fallback) {
  const names = listTerminals({ home: ctx.home })
    .filter((terminal) => terminal.kind !== "none")
    .map((terminal) => terminal.name);
  const answer = (
    await ctx.prompter.ask("默认终端（回车=" + fallback + "；可选 " + names.join(" / ") + "；q 跳过）：")
  ).toLowerCase();
  if (answer === "q") return null;
  if (!answer) return fallback;
  const found = terminalByName({ home: ctx.home, name: answer });
  if (!found || found.kind === "none") {
    process.stderr.write("[W_TERMINAL] 没有这个终端：" + answer + "，改用 " + fallback + "\n");
    return fallback;
  }
  return answer;
}

async function stepDirs(ctx) {
  const defaultHome = ctx.home;
  if (ctx.choices.homeSkipped) return skipped("已跳过数据目录");
  if (ctx.interactive && !ctx.choices.home) {
    const chosen = await chooseRoot(ctx, defaultHome);
    ctx.asked = true;
    if (!chosen) {
      ctx.choices.homeSkipped = true;
      return skipped("已跳过数据目录");
    }
    ctx.choices.home = chosen;
  }
  if (ctx.choices.home) ctx.home = ctx.choices.home;

  const dirs = [ctx.home, ledgerDir(ctx.home), path.join(ctx.home, "memory"), path.join(ctx.home, "inbox"), path.join(ctx.home, "approvals")];
  const missing = dirs.filter((dir) => !fs.existsSync(dir));
  if (!missing.length) return skipped("数据目录已就绪：" + ctx.home);
  if (ctx.dryRun) return planned("将创建 " + missing.length + " 个目录", { dirs: missing }, missing);
  for (const dir of missing) ensureDir(dir);
  return created("已创建 " + missing.length + " 个目录", { dirs: missing }, missing);
}

async function stepConfig(ctx) {
  const file = configFile({ home: ctx.home });
  if (ctx.choices.configSkipped) return skipped("已跳过全局配置");
  const read = readGlobalConfig({ home: ctx.home });
  const defaults = Object.fromEntries(CONFIG_KEYS.map((spec) => [spec.key, spec.default]));

  // 只补"文件里没有"的键：非法值已经有警告，不替用户改写
  const missing = CONFIG_KEYS.filter((spec) => !read.present.includes(spec.key)).map((spec) => spec.key);

  let edits = ctx.choices.configEdits || {};
  if (!ctx.choices.configAsked && ctx.interactive) {
    ctx.choices.configAsked = true;
    const lines = ["全局配置（当前生效值；回车=只补缺省，输入 key=value 修改，q 跳过）：", ...configValueLines(ctx), ""];
    process.stdout.write(lines.join("\n") + "\n");
    const answer = await ctx.prompter.ask("改哪些（如 port=7799 authRequired=false）：");
    ctx.asked = true;
    if (answer.toLowerCase() === "q") {
      ctx.choices.configSkipped = true;
      return skipped("已跳过全局配置");
    }
    edits = parseConfigEdits(answer);
    ctx.choices.configEdits = edits;
  }

  const patch = { ...Object.fromEntries(missing.map((key) => [key, defaults[key]])), ...edits };
  const keys = Object.keys(patch);
  if (!keys.length) {
    return read.warnings.length
      ? warning("配置已存在：" + file + "；" + read.warnings.length + " 个键被忽略", { file, warnings: read.warnings }, read.warnings)
      : skipped("配置已存在：" + file);
  }

  const details = [...keys.map((key) => key + " = " + String(patch[key] === "" ? "（默认目录）" : patch[key])), ...read.warnings];
  const writtenFromDefaults = keys.every((key) => !Object.prototype.hasOwnProperty.call(edits, key));
  const action = read.exists
    ? writtenFromDefaults
      ? "补了 " + keys.length + " 个默认键"
      : "已写入 " + keys.length + " 个键"
    : "已写入 " + keys.length + " 个默认键";

  if (ctx.dryRun) {
    return planned(
      (read.exists ? "将写入 " : "将写入 ") + keys.length + " 个键 → " + file,
      { file, keys, patch },
      details,
    );
  }
  writeGlobalConfig({ home: ctx.home, patch });
  return read.warnings.length
    ? warning(action + " → " + file + "；" + read.warnings.length + " 个键被忽略", { file, keys, warnings: read.warnings }, details)
    : created(action + " → " + file, { file, keys, patch }, details);
}

function stepMemory(ctx) {
  const memory = initMemory({ home: ctx.home, dryRun: ctx.dryRun });
  if (!memory.created.length) return skipped("记忆骨架已存在：" + memory.dir);
  const files = memory.created.map((item) => item.split(path.sep).join("/"));
  const absolute = memory.created.map((item) => path.join(memory.dir, item));
  if (ctx.dryRun) return planned("将补 " + files.length + " 个文件 → " + memory.dir, { dir: memory.dir, files }, absolute);
  return created("已补 " + files.length + " 个文件 → " + memory.dir, { dir: memory.dir, files }, absolute);
}

async function stepWorker(ctx) {
  const current = defaultWorkerName({ home: ctx.home });
  if (current) return skipped("默认执行者 = " + current);
  if (ctx.choices.workerSkipped) return skipped("已跳过默认执行者");

  const installed = listWorkers({ home: ctx.home }).filter((worker) => worker.source === "builtin" && worker.installed);
  if (!installed.length) {
    return warning("没有可用的内置执行者；先安装 claude / codex 等，再 mo worker use <名>", {
      installed: listWorkers({ home: ctx.home }).map((worker) => worker.name),
    });
  }

  let picked;
  if (ctx.choices.worker) {
    picked = installed.find((worker) => worker.name === ctx.choices.worker) || installed[0];
  } else if (ctx.interactive) {
    const chosen = await chooseWorker(installed, ctx.prompter);
    ctx.asked = true;
    if (!chosen) {
      ctx.choices.workerSkipped = true;
      return skipped("已跳过默认执行者");
    }
    picked = chosen;
    ctx.choices.worker = picked.name;
  } else {
    picked = installed[0];
  }

  const operation = "mo worker use " + picked.name + "  →  " + path.join(ctx.home, "workers.json");
  if (ctx.dryRun) return planned("将设默认执行者 = " + picked.name, { name: picked.name }, [operation]);
  const saved = setDefaultWorker({ home: ctx.home, name: picked.name });
  return created("默认执行者 = " + saved.name + (saved.session ? "（会话型）" : "（无头）"), { name: saved.name }, [operation]);
}

async function stepTerminal(ctx) {
  const current = currentTerminal({ home: ctx.home });
  if (current) return skipped("默认终端 = " + current);
  if (ctx.choices.terminalSkipped) return skipped("已跳过默认终端");

  const file = terminalsFile(ctx.home);
  const detected = detectTerminal();
  const fallback = detected === "none" ? "print" : detected;

  let name = ctx.choices.terminal;
  if (!name && ctx.interactive) {
    name = await chooseTerminal(ctx, fallback);
    ctx.asked = true;
    if (!name) {
      ctx.choices.terminalSkipped = true;
      return skipped("已跳过默认终端");
    }
    ctx.choices.terminal = name;
  }
  name = name || fallback;

  const isPrintFallback = detected === "none" && name === "print";
  const operation = "mo terminal use " + name + "  →  " + file;
  if (ctx.dryRun) {
    return planned(isPrintFallback ? "没有探测到图形终端，将设 print" : "将设默认终端 = " + name, { name }, [operation]);
  }
  setDefaultTerminal({ home: ctx.home, name });
  return isPrintFallback
    ? warning("没有探测到图形终端，已设 print（只生成脚本，不开窗口）", { name }, [operation])
    : created("默认终端 = " + name + (name === "iterm" ? "（iTerm2）" : name === "terminal" ? "（Terminal.app）" : ""), { name }, [operation]);
}

async function stepSkill(ctx) {
  const installed = allTargets().filter((target) => target.installed);
  if (installed.length) return skipped("技能已装：" + installed.map((target) => target.name).join(" / "));
  if (ctx.choices.skillSkipped) return skipped("已跳过技能");

  let chosen;
  if (ctx.choices.skillTargets) {
    chosen = ctx.choices.skillTargets;
  } else if (ctx.interactive) {
    chosen = await chooseTargets(ctx.prompter);
    ctx.asked = true;
    if (!chosen.length) {
      ctx.choices.skillSkipped = true;
      return skipped("已跳过技能");
    }
    ctx.choices.skillTargets = chosen;
  } else {
    chosen = resolveTargets([]);
  }

  const destinations = chosen.map((target) => path.join(target.dir, SKILL_NAME, "SKILL.md"));
  if (ctx.dryRun) return planned("将安装到 " + chosen.length + " 个目标", { targets: chosen.map((target) => target.name) }, destinations);
  if (!ctx.explicitYes && !ctx.interactive && !ctx.choices.skillTargets) {
    return skipped("非交互且未加 --yes；手动：mo skill install");
  }
  const written = installSkillTargets(chosen);
  return created("已装技能 " + written.length + " 处", { written: written.map((item) => item.path) }, written.map((item) => item.path));
}

/** 只认已知路径；找不到就跳过，不猜别人的配置往哪写 */
function mcpCandidates(home) {
  return [path.join(home, ".claude.json"), path.join(home, ".mcp.json"), path.join(home, ".agents", "mcp.json")].filter((file) =>
    fs.existsSync(file),
  );
}

async function stepMcp(ctx) {
  const candidates = mcpCandidates(ctx.home);
  if (!candidates.length) return skipped("没有找到 MCP 配置文件；手动：mo agent add --mcp <文件>");
  if (ctx.choices.mcpSkipped) return skipped("已跳过 MCP 配置");

  let target = null;
  let existing = null;
  for (const file of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const servers = parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
    if (servers.mo || servers["mo-agent"]) {
      existing = file;
      break;
    }
    if (!target) target = file;
  }

  if (existing) return skipped("MCP 配置已有 mo 条目：" + existing);
  if (!target) return skipped("找到的 MCP 配置不是合法 JSON；手动：mo agent add --mcp <文件>");

  if (!ctx.choices.mcpConfirmed && ctx.interactive) {
    const answer = (await ctx.prompter.ask("写入 MCP 配置 " + target + "？(y/N) ")).toLowerCase();
    ctx.asked = true;
    if (answer !== "y" && answer !== "yes") {
      ctx.choices.mcpSkipped = true;
      return skipped("已跳过 MCP 配置");
    }
    ctx.choices.mcpConfirmed = target;
  }

  const details = ["服务名：mo-agent", "写前备份：" + target + ".bak-<时间>"];
  if (ctx.dryRun) return planned("将合并 mcpServers → " + target, { file: target }, details);

  const merged = mergeMcpConfig({ target, serverName: "mo-agent" });
  return created((merged.changed ? "已写入 MCP 配置 → " : "MCP 配置已是最新 → ") + merged.file, {
    file: merged.file,
    server: merged.server,
    backup: merged.backup,
  }, [
    "服务名：" + merged.server,
    ...(merged.backup ? ["备份：" + merged.backup] : []),
  ]);
}

const STEPS = [
  { id: "dirs", title: "数据目录", run: stepDirs },
  { id: "config", title: "全局配置", run: stepConfig },
  { id: "memory", title: "记忆骨架", run: stepMemory },
  { id: "worker", title: "默认执行者", run: stepWorker },
  { id: "terminal", title: "默认终端", run: stepTerminal },
  { id: "skill", title: "技能", run: stepSkill },
  { id: "mcp", title: "MCP", run: stepMcp },
];

function parseIdList(options, name, validIds) {
  const ids = all(options, name)
    .flatMap((value) => String(value).split(/[,，\s]+/))
    .map((value) => value.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!validIds.includes(id)) {
      throw new MoError("E_USAGE", "未知步骤：" + id, { hint: "可用：" + validIds.join(" / ") });
    }
  }
  return ids;
}

function remainingActions(report) {
  return report.checks
    .filter((check) => !check.ok)
    .map((check) => ({ check: check.name, value: check.value, action: REMEDY[check.name] || "mo doctor 查看" }));
}

function entryLines(entry) {
  const lines = [(STATUS_ICON[entry.status] || "·") + " " + entry.title + "  " + entry.message];
  for (const item of entry.lines || []) lines.push("    - " + item);
  return lines;
}

function summaryLines(report, remaining) {
  const notes = report.checks.filter((check) => !check.ok);
  const lines = ["汇总：自检" + (notes.length ? "有 " + notes.length + " 项待处理" : "全部通过")];
  for (const check of notes) lines.push("  ⚠ " + check.name.padEnd(12) + " " + check.value);
  if (remaining.length) {
    lines.push("", "剩余动作：");
    for (const item of remaining) lines.push("  - " + item.action);
  }
  return lines;
}

async function runSteps(runCtx, selected) {
  const results = [];
  for (const step of STEPS) {
    if (!selected.includes(step)) continue;
    const entry = { id: step.id, title: step.title };
    runCtx.asked = false;
    try {
      Object.assign(entry, await step.run(runCtx));
    } catch (error) {
      const message = error instanceof MoError ? "[" + error.code + "] " + error.message : String((error && error.message) || error);
      Object.assign(entry, failed(message));
    }
    entry.asked = Boolean(runCtx.asked);
    results.push(entry);
  }
  return results;
}

/** 交互 dry-run：一步步展示，每步之间等 Enter，选择放在该步执行时问 */
async function runPaged(runCtx, selected, prompter) {
  const steps = STEPS.filter((step) => selected.includes(step));
  const results = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const entry = { id: step.id, title: step.title };
    runCtx.asked = false;
    try {
      Object.assign(entry, await step.run(runCtx));
    } catch (error) {
      const message = error instanceof MoError ? "[" + error.code + "] " + error.message : String((error && error.message) || error);
      Object.assign(entry, failed(message));
    }
    entry.asked = Boolean(runCtx.asked);
    results.push(entry);
    process.stdout.write(entryLines(entry).join("\n") + "\n");
    // 已经让你选过的步骤不再多要一次回车
    if (index < steps.length - 1 && !entry.asked) {
      process.stdout.write("\n按 Enter 继续...");
      await prompter.ask("");
    }
  }
  return results;
}

export async function setupCommand(ctx, args) {
  const defaultHome = moHome();
  const options = args.options;
  const validIds = STEPS.map((step) => step.id);
  const only = parseIdList(options, "only", validIds);
  const skip = parseIdList(options, "skip", validIds);

  const dryRun = has(options, "dry-run");
  const explicitYes = has(options, "yes");
  // --json 是自动化出口：不弹问题，免得提示混进 JSON
  const interactive = Boolean(process.stdin.isTTY) && !explicitYes && !isJson(options);
  // 交互 dry-run：逐步展示 + 最后确认是否执行
  const paged = interactive && dryRun;

  const runCtx = {
    home: defaultHome,
    cwd: ctx.cwd,
    dryRun,
    explicitYes,
    interactive,
    choices: {},
    prompter: interactive ? makePrompter() : null,
  };

  const selected = STEPS.filter((step) => (only.length ? only.includes(step.id) : true) && !skip.includes(step.id));

  let results = [];
  let applied = false;
  try {
    if (paged) {
      process.stdout.write(
        "mo setup（--dry-run）\n\n下面每步都是真实会执行的操作，只是不落地（不写任何文件）：\n按 Enter 继续...",
      );
      await runCtx.prompter.ask("");
      results = await runPaged(runCtx, selected, runCtx.prompter);
      if (results.some((entry) => entry.status === "planned")) {
        const answer = (await runCtx.prompter.ask("\n按这个计划真实执行吗？(y/N) ")).toLowerCase();
        if (answer === "y" || answer === "yes") {
          results = await runSteps({ ...runCtx, dryRun: false, interactive: false }, selected);
          applied = true;
        }
      }
    } else {
      results = await runSteps(runCtx, selected);
    }
  } finally {
    if (runCtx.prompter) runCtx.prompter.close();
  }

  const effectiveDryRun = dryRun && !applied;
  const report = doctorReport(ctx.cwd, { home: runCtx.home });
  const remaining = remainingActions(report);
  const ok = !results.some((entry) => entry.status === "warn" || entry.status === "failed");
  const homeIsDefault = runCtx.home === defaultHome;
  const payload = {
    ok,
    home: runCtx.home,
    homeIsDefault,
    dryRun: effectiveDryRun,
    applied,
    steps: results,
    doctor: { ok: report.ok, checks: report.checks },
    remaining,
  };

  const homeNote = () =>
    homeIsDefault
      ? []
      : ["", "数据目录不在默认位置：" + runCtx.home, "  其它 mo 命令要加 MO_AGENT_HOME=" + runCtx.home + " 才会用它"];

  if (paged) {
    if (applied) {
      const lines = ["\n已按计划执行："];
      for (const entry of results) lines.push(...entryLines(entry));
      process.stdout.write(lines.join("\n") + "\n");
    } else {
      process.stdout.write("\n（没有执行任何操作）\n");
    }
    process.stdout.write("\n" + [...summaryLines(report, remaining), ...homeNote()].join("\n") + "\n");
    return ok ? 0 : 1;
  }

  emit(args.options, payload, () => {
    const lines = ["mo setup" + (dryRun ? "（--dry-run）" : ""), ""];
    if (dryRun) lines.push("下面每步都是真实会执行的操作，只是不落地（不写任何文件）：", "");
    for (const entry of results) lines.push(...entryLines(entry));
    lines.push("", ...summaryLines(report, remaining), ...homeNote());
    return lines.join("\n");
  });

  return ok ? 0 : 1;
}