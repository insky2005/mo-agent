import path from "node:path";
import readline from "node:readline/promises";
import { MoError } from "../../core/errors.mjs";
import {
  attachProject,
  findRegisteredProject,
  listProjects,
  purgeProjectDir,
  removeProject,
} from "../lib/project.mjs";
import { moHome, projectDir } from "../lib/paths.mjs";
import { exists } from "../lib/fsx.mjs";
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

  if (sub === "remove") {
    return removeProjectCommand(ctx, args, home);
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

  throw new MoError("E_USAGE", "未知子命令：project " + sub + "（可用：init / agent / list / remove）");
}

async function askYesNo(lines) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(lines.join("\n") + "\n> ");
    const answer = (await rl.question("")).trim().toLowerCase();
    return /^(y|yes|是)$/.test(answer);
  } finally {
    rl.close();
  }
}

/**
 * mo project remove [名称|id|路径] [--path <路径>] [--purge] [--dry-run] [--yes]
 *
 * 默认只从注册表移除，不碰仓库文件；--purge 才删 <repo>/.mo-agent/，且要人工确认。
 */
async function removeProjectCommand(ctx, args, home) {
  const target = args.positional[1] || one(args.options, "id");
  const pathOnly = one(args.options, "path");
  const purge = has(args.options, "purge");
  const dryRun = has(args.options, "dry-run");

  // 先做一次只读查找，用于展示与确认
  const found = findRegisteredProject({ cwd: ctx.cwd, home, target });
  const paths = pathOnly ? [path.resolve(ctx.cwd, String(pathOnly))] : found.entry.paths || [];

  if (purge && !dryRun) {
    if (!process.stdin.isTTY && !has(args.options, "yes")) {
      throw new MoError("E_FORBIDDEN", "--purge 会删掉仓库里的 .mo-agent/，只能在终端确认或显式加 --yes", {
        hint: "不想删文件就别加 --purge，默认只移除登记",
      });
    }
    if (process.stdin.isTTY && !has(args.options, "yes")) {
      const ok = await askYesNo([
        "要删除这些目录里的 .mo-agent/ 吗？任务卡与回执也会一起没。",
        "",
        ...paths.map((item) => "  " + item + (exists(projectDir(item)) ? "（存在）" : "（不存在）")),
      ]);
      if (!ok) {
        emit(args.options, { ok: false, cancelled: true }, "已取消");
        return 0;
      }
    }
  }

  const result = removeProject({ cwd: ctx.cwd, home, target, pathOnly, purge, dryRun });

  const purged = [];
  if (purge && !dryRun) {
    for (const root of result.removedPaths) {
      if (purgeProjectDir(root)) purged.push(root);
    }
  }

  emit(
    args.options,
    { ok: true, ...result, purged },
    () => {
      const lines = [
        result.dryRun ? "（--dry-run，没有改动任何东西）" : "✓ 已移除项目登记",
        "",
        "  项目   " + (result.name || "-") + "  " + result.id,
        "  移除   " + (result.removedPaths.join(", ") || "（无）"),
      ];
      if (result.remainingPaths.length) lines.push("  保留   " + result.remainingPaths.join(", "));
      if (purged.length) lines.push("  已删   " + purged.map((item) => path.join(item, ".mo-agent")).join(", "));
      if (!result.remainingPaths.length && !result.dryRun) lines.push("", "这个项目已经从本机注册表移除。");
      lines.push(
        "",
        result.dryRun
          ? "确认无误后去掉 --dry-run 再执行。"
          : purged.length
            ? "任务卡已随 .mo-agent/ 一起删除；要回来只能从备份或 git 恢复。"
            : "仓库里的任务卡不受影响；需要重新登记：mo project init .",
      );
      return lines.join("\n");
    },
  );
  return 0;
}

export function parseProjectOption(args) {
  return one(args.options, "project");
}

export function parseAll(args, key) {
  return all(args.options, key);
}