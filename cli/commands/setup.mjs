import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { MoError } from "../../core/errors.mjs";
import { all, has } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { ledgerDir, moHome } from "../lib/paths.mjs";
import { ensureDir } from "../lib/fsx.mjs";
import { CONFIG_KEYS, configFile, readGlobalConfig, writeGlobalConfig } from "../lib/config.mjs";
import { initMemory } from "./memory.mjs";
import { allTargets, installSkillTargets, resolveTargets } from "./skill.mjs";
import { mergeMcpConfig } from "./agent-add.mjs";
import { defaultWorkerName, listWorkers, setDefaultWorker } from "../lib/workers-config.mjs";
import { currentTerminal, detectTerminal, setDefaultTerminal } from "../lib/terminals.mjs";
import { doctorReport } from "./doctor.mjs";

/**
 * mo setup —— 首次装配，幂等。
 *
 * 只串已有命令/函数，不重写逻辑；绝不碰仓库（不建 project.json、不写
 * <repo>/.mo-agent/、不改 AGENTS.md），也不启动 daemon。
 */

const STATUS_ICON = { created: "✓", skipped: "⏭", planned: "·", warn: "⚠", failed: "✗" };

const REMEDY = {
  home: "mo setup",
  ledger: "建一张卡，或再跑一次 mo setup",
  memory: "mo memory init",
  projects: "mo project init <仓库>",
  "cwd-project": "mo project init .",
};

function result(status, message, detail) {
  return { status, message, ...(detail === undefined ? {} : { detail }) };
}

const created = (message, detail) => result("created", message, detail);
const skipped = (message, detail) => result("skipped", message, detail);
const planned = (message, detail) => result("planned", message, detail);
const warning = (message, detail) => result("warn", message, detail);
const failed = (message, detail) => result("failed", message, detail);

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

async function stepDirs(ctx) {
  const dirs = [ctx.home, ledgerDir(ctx.home), path.join(ctx.home, "memory"), path.join(ctx.home, "inbox"), path.join(ctx.home, "approvals")];
  const missing = dirs.filter((dir) => !fs.existsSync(dir));
  if (!missing.length) return skipped("数据目录已就绪：" + ctx.home);
  if (ctx.dryRun) return planned("将创建 " + missing.length + " 个目录", { dirs: missing });
  for (const dir of missing) ensureDir(dir);
  return created("已创建 " + missing.length + " 个目录：" + missing.map((dir) => path.basename(dir)).join(" / "), { dirs: missing });
}

function stepConfig(ctx) {
  const file = configFile({ home: ctx.home });
  const read = readGlobalConfig({ home: ctx.home });
  const defaults = Object.fromEntries(CONFIG_KEYS.map((spec) => [spec.key, spec.default]));

  if (!read.exists) {
    if (ctx.dryRun) return planned("将写入 " + CONFIG_KEYS.length + " 个默认键 → " + file, { file });
    writeGlobalConfig({ home: ctx.home, patch: defaults });
    return created("已写入默认配置 → " + file, { file, keys: Object.keys(defaults) });
  }

  // 只补"文件里没有"的键：非法值已经有警告，不替用户改写
  const missing = CONFIG_KEYS.filter((spec) => !read.present.includes(spec.key)).map((spec) => spec.key);
  const extraWarning = read.warnings.length ? "；另有 " + read.warnings.length + " 个键被忽略" : "";
  if (!missing.length) {
    return read.warnings.length ? warning("配置已存在：" + file + extraWarning, { file, warnings: read.warnings }) : skipped("配置已存在：" + file);
  }
  if (ctx.dryRun) return planned("将补齐 " + missing.length + " 个默认键：" + missing.join(" / "), { file, keys: missing });
  writeGlobalConfig({ home: ctx.home, patch: Object.fromEntries(missing.map((key) => [key, defaults[key]])) });
  return read.warnings.length
    ? warning("补了 " + missing.length + " 个键" + extraWarning, { file, keys: missing, warnings: read.warnings })
    : created("补了 " + missing.length + " 个默认键：" + missing.join(" / "), { file, keys: missing });
}

function stepMemory(ctx) {
  const memory = initMemory({ home: ctx.home, dryRun: ctx.dryRun });
  if (!memory.created.length) return skipped("记忆骨架已存在：" + memory.dir);
  const files = memory.created.map((item) => item.split(path.sep).join("/"));
  if (ctx.dryRun) return planned("将补 " + files.length + " 个文件：" + files.join(" / "), { dir: memory.dir, files });
  return created("已补 " + files.length + " 个文件：" + files.join(" / "), { dir: memory.dir, files });
}

async function stepWorker(ctx) {
  const current = defaultWorkerName({ home: ctx.home });
  if (current) return skipped("默认执行者 = " + current);

  const installed = listWorkers({ home: ctx.home }).filter((worker) => worker.source === "builtin" && worker.installed);
  if (!installed.length) {
    return warning("没有可用的内置执行者；先安装 claude / codex 等，再 mo worker use <名>", {
      installed: listWorkers({ home: ctx.home }).map((worker) => worker.name),
    });
  }

  let picked = installed[0];
  if (ctx.interactive) {
    const chosen = await chooseWorker(installed, ctx.prompter);
    if (!chosen) return skipped("已跳过默认执行者");
    picked = chosen;
  }

  if (ctx.dryRun) return planned("将设默认执行者 = " + picked.name, { name: picked.name });
  const saved = setDefaultWorker({ home: ctx.home, name: picked.name });
  return created("默认执行者 = " + saved.name + (saved.session ? "（会话型）" : "（无头）"), { name: saved.name });
}

function stepTerminal(ctx) {
  const current = currentTerminal({ home: ctx.home });
  if (current) return skipped("默认终端 = " + current);

  const detected = detectTerminal();
  if (detected === "none") {
    if (ctx.dryRun) return planned("没有探测到图形终端，将设 print", { name: "print" });
    setDefaultTerminal({ home: ctx.home, name: "print" });
    return warning("没有探测到图形终端，已设 print（只生成脚本，不开窗口）", { name: "print" });
  }

  if (ctx.dryRun) return planned("将设默认终端 = " + detected, { name: detected });
  setDefaultTerminal({ home: ctx.home, name: detected });
  return created("默认终端 = " + detected + (detected === "iterm" ? "（iTerm2）" : "（Terminal.app）"), { name: detected });
}

function stepSkill(ctx) {
  const installed = allTargets().filter((target) => target.installed);
  if (installed.length) return skipped("技能已装：" + installed.map((target) => target.name).join(" / "));

  const chosen = resolveTargets([]);
  if (ctx.dryRun) return planned("将安装到：" + chosen.map((target) => target.name).join(" / "), { targets: chosen.map((target) => target.name) });
  if (!ctx.explicitYes && !ctx.interactive) {
    return skipped("非交互且未加 --yes；手动：mo skill install");
  }
  const written = installSkillTargets(chosen);
  return created("已装技能 " + written.length + " 处", { written: written.map((item) => item.path) });
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
  if (ctx.dryRun) return planned("将合并 mcpServers → " + target, { file: target });

  if (ctx.interactive) {
    const answer = (await ctx.prompter.ask("写入 MCP 配置 " + target + "？(y/N) ")).toLowerCase();
    if (answer !== "y" && answer !== "yes") return skipped("已跳过 MCP 配置");
  }

  const merged = mergeMcpConfig({ target, serverName: "mo-agent" });
  return created((merged.changed ? "已写入 MCP 配置 → " : "MCP 配置已是最新 → ") + merged.file, {
    file: merged.file,
    server: merged.server,
    backup: merged.backup,
  });
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

export async function setupCommand(ctx, args) {
  const home = moHome();
  const options = args.options;
  const validIds = STEPS.map((step) => step.id);
  const only = parseIdList(options, "only", validIds);
  const skip = parseIdList(options, "skip", validIds);

  const dryRun = has(options, "dry-run");
  const explicitYes = has(options, "yes");
  const interactive = Boolean(process.stdin.isTTY) && !explicitYes && !dryRun;

  const runCtx = {
    home,
    cwd: ctx.cwd,
    dryRun,
    explicitYes,
    interactive,
    prompter: interactive ? makePrompter() : null,
  };

  const selected = STEPS.filter((step) => (only.length ? only.includes(step.id) : true) && !skip.includes(step.id));
  const results = [];
  try {
    for (const step of STEPS) {
      if (!selected.includes(step)) continue;
      const entry = { id: step.id, title: step.title };
      try {
        Object.assign(entry, await step.run(runCtx));
      } catch (error) {
        const message = error instanceof MoError ? "[" + error.code + "] " + error.message : String((error && error.message) || error);
        Object.assign(entry, failed(message));
      }
      results.push(entry);
    }
  } finally {
    if (runCtx.prompter) runCtx.prompter.close();
  }

  const report = doctorReport(ctx.cwd);
  const remaining = remainingActions(report);
  const ok = !results.some((entry) => entry.status === "warn" || entry.status === "failed");

  emit(
    args.options,
    { ok, home, dryRun, steps: results, doctor: { ok: report.ok, checks: report.checks }, remaining },
    () => {
      const lines = ["mo setup" + (dryRun ? "（--dry-run）" : ""), ""];
      for (const entry of results) {
        lines.push((STATUS_ICON[entry.status] || "·") + " " + entry.title + "  " + entry.message);
      }
      const notes = report.checks.filter((check) => !check.ok);
      lines.push("", "汇总：自检" + (notes.length ? "有 " + notes.length + " 项待处理" : "全部通过"));
      for (const check of notes) lines.push("  ⚠ " + check.name.padEnd(12) + " " + check.value);
      if (remaining.length) {
        lines.push("", "剩余动作：");
        for (const item of remaining) lines.push("  - " + item.action);
      }
      return lines.join("\n");
    },
  );

  return ok ? 0 : 1;
}
