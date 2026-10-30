import { MoError } from "../../core/errors.mjs";
import { filterEvents } from "../../core/tasks/ledger.mjs";
import { all, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { readEvents } from "../lib/store.mjs";
import { resolveProject } from "../lib/project.mjs";

export function ledgerCommand(ctx, args) {
  const sub = args.positional[0] || "query";
  if (sub !== "query") {
    throw new MoError("E_USAGE", "未知子命令：ledger " + sub + "（可用：query）");
  }
  const home = moHome();
  let project;
  const target = one(args.options, "project");
  if (target) {
    project = resolveProject({ cwd: ctx.cwd, target, home, autoAttach: false }).meta.id;
  }

  const days = Number(one(args.options, "days", 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const limit = Number(one(args.options, "limit", 50));

  const events = filterEvents(readEvents(home), {
    project,
    taskId: one(args.options, "task"),
    type: one(args.options, "type"),
    since,
  }).slice(-limit);

  emit(args.options, { events }, () =>
    events.length
      ? table(events.map((e) => [e.at, e.type, e.taskId, e.project, e.actor]), ["时间", "事件", "任务", "项目", "发起"])
      : "没有匹配的账本事件");
  return 0;
}
