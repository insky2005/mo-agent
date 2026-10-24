import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { attachProject, listProjects } from "../lib/project.mjs";
import { moHome } from "../lib/paths.mjs";
import { all, has, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { applyAgentFile, projectAgent } from "./agent.mjs";

export function projectCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  const home = moHome();

  // init 是主名字；add 保留为别名
  if (sub === "init" || sub === "add") {
    const dir = args.positional[1] ? path.resolve(ctx.cwd, args.positional[1]) : ctx.cwd;
    const attached = attachProject(dir, { name: one(args.options, "name"), home });

    let agent = null;
    if (!has(args.options, "no-agent-file")) {
      agent = applyAgentFile({
        root: attached.root,
        file: one(args.options, "file"),
        mode: one(args.options, "mode", "auto"),
      });
    }

    const agentLabel = agent ? path.relative(attached.root, agent.file) : "已跳过";
    emit(
      args.options,
      { ok: true, id: attached.meta.id, name: attached.meta.name, root: attached.root, agent: agent && { ...agent, file: path.relative(attached.root, agent.file) } },
      () =>
        "✓ " + attached.meta.name + "  " + attached.meta.id + "\n"
        + "  " + agentLabel + (agent ? "（" + { skill: "技能指针", ref: "MO.md + 引用", inline: "内联用法" }[agent.mode] + "）" : ""),
    );
    return 0;
  }

  if (sub === "agent") {
    return projectAgent(ctx, args);
  }

  if (sub === "list") {
    const projects = listProjects(home);
    if (!projects.length) {
      emit(args.options, { projects: [] }, "还没有登记任何项目。在项目目录执行 mo project init");
      return 0;
    }
    emit(args.options, { projects }, () =>
      table(
        projects.map((p) => [p.name || "-", p.id, p.missing ? "缺失" : "正常", p.paths[0] || "-"]),
        ["名称", "id", "状态", "路径"],
      ));
    return 0;
  }

  throw new MoError("E_USAGE", "未知子命令：project " + sub + "（可用：init / agent / list）");
}

export function parseProjectOption(args) {
  return one(args.options, "project");
}

export function parseAll(args, key) {
  return all(args.options, key);
}