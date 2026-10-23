import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { attachProject, listProjects } from "../lib/project.mjs";
import { moHome } from "../lib/paths.mjs";
import { all, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";

export function projectCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  const home = moHome();

  if (sub === "add") {
    const dir = args.positional[1] ? path.resolve(ctx.cwd, args.positional[1]) : ctx.cwd;
    const attached = attachProject(dir, { name: one(args.options, "name"), home });
    emit(args.options, { ok: true, id: attached.meta.id, name: attached.meta.name, root: attached.root },
      "已登记项目 " + attached.meta.name + "\n  id:   " + attached.meta.id + "\n  根目录: " + attached.root);
    return 0;
  }

  if (sub === "list") {
    const projects = listProjects(home);
    if (!projects.length) {
      emit(args.options, { projects: [] }, "还没有登记任何项目。在项目目录执行 mo project add .");
      return 0;
    }
    emit(args.options, { projects }, () =>
      table(
        projects.map((p) => [p.name || "-", p.id, p.missing ? "缺失" : "正常", p.paths[0] || "-"]),
        ["名称", "id", "状态", "路径"],
      ));
    return 0;
  }

  throw new MoError("E_USAGE", "未知子命令：project " + sub + "（可用：add / list）");
}

export function parseProjectOption(args) {
  return one(args.options, "project");
}

export function parseAll(args, key) {
  return all(args.options, key);
}
