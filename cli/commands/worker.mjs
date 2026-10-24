import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { findProjectRoot, resolveProject } from "../lib/project.mjs";
import { addWorker, listWorkers, removeWorker } from "../lib/workers-config.mjs";

const SOURCE_LABEL = { builtin: "内置", user: "个人", project: "项目" };

function projectRootFor(cwd, options) {
  const target = one(options, "project");
  if (target) return resolveProject({ cwd, target, home: moHome() }).root;
  return findProjectRoot(cwd);
}

/** mo worker list|add|remove */
export function workerCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  if (sub === "list") return list(ctx, args);
  if (sub === "add") return add(ctx, args);
  if (sub === "remove") return remove(ctx, args);
  throw new MoError("E_USAGE", "未知子命令：worker " + sub + "（可用：list / add / remove）");
}

function list(ctx, args) {
  const workers = listWorkers({ home: moHome(), projectRoot: projectRootFor(ctx.cwd, args.options) });
  const rows = workers.map((worker) => [
    worker.name,
    SOURCE_LABEL[worker.source] || worker.source,
    worker.installed ? "✓" : "✗ 缺 " + worker.missing.map((item) => item.split("/").pop()).join(", "),
    worker.command,
    worker.description || "",
  ]);

  const missing = workers
    .filter((worker) => !worker.installed)
    .flatMap((worker) => worker.missing.map((item) => item.split("/").pop()));

  emit(args.options, { workers }, () => {
    const lines = [
      table(rows, ["执行者", "来源", "已装", "命令", "说明"]).replace(/[ \t]+$/gm, ""),
      "",
      "用法：mo task create --worker <执行者>",
      "自定义：mo worker add <名称> --command '<命令>'",
    ];
    if (missing.length) {
      lines.push("不可用：" + [...new Set(missing)].join(" / ") + "（对应执行者选不了）");
    }
    return lines.join("\n");
  });
  return 0;
}

function add(ctx, args) {
  const name = args.positional[1];
  if (!name) throw new MoError("E_USAGE", "缺少名称：mo worker add <名称> --command '<命令>'");

  const project = has(args.options, "project");
  const projectRoot = project ? resolveProject({ cwd: ctx.cwd, home: moHome() }).root : null;

  const result = addWorker({
    name,
    command: one(args.options, "command", ""),
    description: one(args.options, "description", ""),
    requires: one(args.options, "requires", ""),
    project,
    home: moHome(),
    projectRoot,
  });

  emit(args.options, { ok: true, ...result, project }, () =>
    "✓ " + result.name + " → " + result.file + (project ? "（项目）" : "（个人）"));
  return 0;
}

function remove(ctx, args) {
  const name = args.positional[1];
  if (!name) throw new MoError("E_USAGE", "缺少名称：mo worker remove <名称>");

  const project = has(args.options, "project");
  const projectRoot = project ? resolveProject({ cwd: ctx.cwd, home: moHome() }).root : findProjectRoot(ctx.cwd);
  const result = removeWorker({ name, project, home: moHome(), projectRoot });

  emit(args.options, { ok: true, ...result, project }, () => "✓ 已移除 " + result.name + (project ? "（项目）" : "（个人）"));
  return 0;
}