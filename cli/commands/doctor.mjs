import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emit, padDisplay } from "../ui/output.mjs";
import { VERSION } from "../lib/version.mjs";
import { moHome, ledgerDir } from "../lib/paths.mjs";
import { listProjects } from "../lib/project.mjs";
import { readEvents } from "../lib/store.mjs";
import { memoryDir } from "../lib/knowledge.mjs";
import { cachedUpdate } from "../lib/upgrade.mjs";
import { credentialsFile, routerFile, runtimeRoot } from "../lib/router-paths.mjs";
import { findHost } from "./daemon.mjs";
import { readJsonSafe } from "../lib/fsx.mjs";

/**
 * 自检：只有必需项失败才算失败。
 * ledger / memory / cwd-project 属于"还没用到"，用 ⚠ 提示，不阻塞。
 */
/** 当前目录是否落在某个已登记项目里（含子目录） */
export function insideProject(cwd, projects) {
  return (projects || []).some((project) =>
    (project.paths || []).some((root) => cwd === root || cwd.startsWith(root + "/") || cwd.startsWith(root + "\\")),
  );
}

/**
 * host：只装 CLI 的人会没有它，而手机批准/监控/钉钉全都要它。
 * 不是必需项——纯 CLI 用工作台不需要 host——但缺了要明说怎么补。
 */
function hostCheck(home) {
  const found = findHost({ env: process.env, home, cwd: process.cwd() });
  if (!found) {
    return {
      name: "host",
      label: "host",
      required: false,
      ok: false,
      value: "没有可用的 host 运行时：mo daemon install（或装桌面版）",
    };
  }
  const entry = found.kind === "source" ? found.command[1] : found.command[0];
  let when = "";
  try {
    when = "（" + fs.statSync(entry).mtime.toISOString().slice(0, 10) + "）";
  } catch {
    when = "";
  }
  const label = found.kind === "env" ? "MO_AGENT_ROOT" : found.kind === "desktop" ? "桌面运行时" : "源码";
  return { name: "host", label: "host", required: false, ok: true, value: label + " · " + entry + when };
}

/**
 * 指挥台：只看有没有装运行时、有没有凭据、跑没跑。
 * 三项都不是必需项——没配过指挥台是完全正常的状态。
 */
function routerCheck(home) {
  const state = readJsonSafe(routerFile(home), null) || {};
  let versions = [];
  try {
    versions = fs
      .readdirSync(path.join(runtimeRoot({ home: os.homedir(), env: process.env }), "routers", "pi"))
      .filter((name) => !name.includes(".tmp-"));
  } catch {
    versions = [];
  }
  const hasCredentials = fs.existsSync(credentialsFile(home));
  const running = Boolean(state.pid);

  let value;
  if (running) value = "运行中（pid " + state.pid + "，模型 " + (state.model || "?") + "）";
  else if (!versions.length) value = "未安装运行时：mo router runtime install";
  else if (!hasCredentials) value = "未配置凭据：mo router setup";
  else value = "已就绪，未运行：mo router start";

  return { name: "router", label: "指挥台", required: false, ok: running, value };
}

/**
 * 建议入口（A3）：doctor 是每个新手都会跑的命令，所以"你该走哪条路"
 * 放在这里最省事——不用读完三篇文档才明白。
 */
export function entryAdvice({ skillInstalled, routerReady, hasTasks } = {}) {
  if (routerReady) {
    return { entry: "指挥台", next: "mo router start（已经在用内置主 Agent）" };
  }
  if (skillInstalled) {
    return { entry: "外部 Agent", next: "在 Agent 里说「用 mo 把这件事落成任务卡」；想换内置主 Agent：mo router start" };
  }
  if (hasTasks) {
    return { entry: "CLI", next: "mo task create …（继续敲命令）" };
  }
  return {
    entry: "还没选",
    next: "三选一：桌面 App + 手机（只看不改）/ mo agent add --mcp（接外部 Agent）/ mo router start（内置指挥台，推荐）",
  };
}

function skillInstalled() {
  try {
    return fs.existsSync(path.join(os.homedir(), ".agents", "skills", "mo", "SKILL.md"));
  } catch {
    return false;
  }
}

/** 只读检查项：mo doctor 与 mo setup 的汇总共用 */
export function doctorReport(cwd, options = {}) {
  const home = options.home || moHome();
  const memory = memoryDir(home);
  const projects = listProjects(home);
  const events = readEvents(home);

  const inProject = insideProject(cwd, projects);
  // 只读本地缓存，不联网：mo upgrade --check 才会刷新它
  const update = cachedUpdate(home, VERSION);
  const checks = [
    { name: "node", label: "Node", required: true, ok: true, value: process.versions.node },
    {
      name: "mo-agent",
      label: "版本",
      required: true,
      ok: true,
      value: VERSION + (update ? "（有新版 " + update.latest + "：mo upgrade）" : ""),
    },
    { name: "home", label: "数据目录", required: true, ok: fs.existsSync(home), value: home },
    { name: "ledger", label: "账本", required: false, ok: fs.existsSync(ledgerDir(home)), value: events.length + " 条事件" },
    { name: "memory", label: "记忆库", required: false, ok: fs.existsSync(memory.dir), value: memory.dir },
    { name: "projects", label: "已登记项目", required: false, ok: projects.length > 0, value: projects.length + " 个" },
    {
      name: "cwd-project",
      label: "当前目录",
      required: false,
      ok: inProject,
      value: cwd + (inProject ? "（属于已登记项目）" : "（未登记为项目）"),
    },
    hostCheck(home),
    routerCheck(home),
  ];

  const advice = entryAdvice({
    skillInstalled: skillInstalled(),
    routerReady: fs.existsSync(credentialsFile(home)),
    hasTasks: events.some((event) => event && event.type === "task.created"),
  });

  const ok = checks.filter((check) => check.required).every((check) => check.ok);
  return { ok, home, memory: memory.dir, memorySource: memory.source, checks, projects, advice };
}

export function doctorCommand(ctx, args) {
  const report = doctorReport(ctx.cwd);
  emit(
    args.options,
    {
      ok: report.ok,
      home: report.home,
      memory: report.memory,
      memorySource: report.memorySource,
      checks: report.checks,
      projects: report.projects,
      advice: report.advice,
    },
    () =>
      report.checks
        .map((check) => (check.ok ? "✓ " : check.required ? "✗ " : "⚠ ") + padDisplay(check.label || check.name, 12) + " " + check.value)
        .concat(["", "下一步   " + report.advice.next])
        .join("\n"),
  );
  return report.ok ? 0 : 1;
}