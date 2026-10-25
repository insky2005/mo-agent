import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { findProjectRoot, resolveProject } from "../lib/project.mjs";
import { addWorker, defaultWorkerName, listWorkers, removeWorker, setDefaultWorker } from "../lib/workers-config.mjs";

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
  if (sub === "use") return use(ctx, args);
  if (sub === "current") return current(ctx, args);
  throw new MoError("E_USAGE", "未知子命令：worker " + sub + "（可用：list / add / remove / use / current）");
}

function list(ctx, args) {
  const workers = listWorkers({ home: moHome(), projectRoot: projectRootFor(ctx.cwd, args.options) });
  const fallback = defaultWorkerName({ home: moHome(), projectRoot: projectRootFor(ctx.cwd, args.options) });
  const rows = workers.map((worker) => [
    worker.name,
    worker.session ? "会话" : "无头",
    SOURCE_LABEL[worker.source] || worker.source,
    worker.installed ? "✓" : "✗ 缺 " + worker.missing.map((item) => item.split("/").pop()).join(", "),
    worker.name === fallback ? "✓" : "",
    worker.command,
    worker.description || "",
  ]);

  const missing = workers
    .filter((worker) => !worker.installed)
    .flatMap((worker) => worker.missing.map((item) => item.split("/").pop()));

  emit(args.options, { workers, default: fallback }, () => {
    const lines = [
      table(rows, ["执行者", "模式", "来源", "已装", "默认", "命令", "说明"]).replace(/[ \t]+$/gm, ""),
      "",
      "默认执行者：" + (fallback || "（未设置；assignee: auto 的卡派单会失败）"),
      "设置默认：mo worker use <执行者>",
      "用法：mo task create --worker <执行者>",
      "自定义：mo worker add <名称> --command '<命令>' [--session] [--use]",
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
    session: has(args.options, "session"),
    use: has(args.options, "use"),
    project,
    home: moHome(),
    projectRoot,
  });

  emit(args.options, { ok: true, ...result, project }, () =>
    "✓ " + result.name + " → " + result.file +
      (result.session ? "（会话型）" : "") +
      (result.default ? "（已设为默认）" : "") +
      (project ? "（项目）" : "（个人）"));
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
function use(ctx, args) {
  const name = args.positional[1];
  const project = has(args.options, "project");
  const projectRoot = project ? resolveProject({ cwd: ctx.cwd, home: moHome() }).root : findProjectRoot(ctx.cwd);

  if (has(args.options, "unset")) {
    const cleared = setDefaultWorker({ home: moHome(), projectRoot, project, clear: true });
    emit(args.options, { ok: true, ...cleared }, "✓ 已清除默认执行者");
    return 0;
  }

  if (!name) return current(ctx, args);

  const result = setDefaultWorker({ home: moHome(), projectRoot, project, name });
  emit(args.options, { ok: true, ...result, project }, () =>
    "✓ 默认执行者 = " + result.name + "（" + (result.session ? "会话型" : "无头") + "）；" +
      (result.installed ? "auto 的卡派单会用它。" : "但它没装好，派单会报错。"));
  return 0;
}

function current(ctx, args) {
  const projectRoot = projectRootFor(ctx.cwd, args.options);
  const name = defaultWorkerName({ home: moHome(), projectRoot });
  if (!name) {
    emit(args.options, { current: "" }, "未设置默认执行者；assignee: auto 的卡派单会失败（mo worker use <名称>）");
    return 0;
  }
  const found = listWorkers({ home: moHome(), projectRoot }).find((worker) => worker.name === name);
  emit(
    args.options,
    { current: name, session: Boolean(found && found.session), installed: Boolean(found && found.installed) },
    "当前默认执行者：" + name + "（" + (found && found.session ? "会话型" : "无头") + "）",
  );
  return 0;
}
