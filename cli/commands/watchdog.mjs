import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { findProjectRoot, listProjects } from "../lib/project.mjs";
import { resolveProject } from "../lib/project.mjs";
import { runWatchdog } from "../lib/watchdog.mjs";

/**
 * mo watchdog run [--project …] [--all] [--dry-run]
 *
 * 给 cron / launchd / daemon 用的一次性清扫；也可以随时手跑。
 */
export function watchdogCommand(ctx, args) {
  const sub = args.positional[0] || "run";
  if (sub !== "run") {
    throw new MoError("E_USAGE", "未知子命令：watchdog " + sub + "（可用：run）");
  }
  const home = moHome();
  const all = has(args.options, "all");
  const dryRun = has(args.options, "dry-run");

  const roots = all ? allRoots(home) : [currentRoot(ctx, args, home)];
  const result = runWatchdog({ home, roots, dryRun });

  emit(
    args.options,
    { ok: true, ...result },
    () => {
      const lines = [
        (dryRun ? "（--dry-run，没有改动）" : "✓ watchdog 完成") +
          "：检查 " + result.checked + " 张，超时 " + result.overdue.length +
          "，过期审批 " + result.expiredApprovals.length,
      ];
      for (const item of result.overdue) {
        const minutes = Math.max(1, Math.round(item.elapsedMs / 60000));
        lines.push(
          "  ⚠ " + item.taskId + "  " + minutes + "m" + (item.session ? "（会话型）" : "") + " → blocked(timeout)",
        );
      }
      if (!result.overdue.length) lines.push("  （没有需要处理的卡）");
      return lines.join("\n");
    },
  );
  return 0;
}

function allRoots(home) {
  const paths = listProjects(home).flatMap((entry) => entry.paths || []);
  const roots = [...new Set(paths)].filter((item) => fs.existsSync(item));
  if (!roots.length) {
    throw new MoError("E_PROJECT_NOT_FOUND", "没有可扫描的项目", { hint: "先 mo project init，或用 mo project list 看看" });
  }
  return roots;
}

function currentRoot(ctx, args, home) {
  const target = one(args.options, "project");
  if (target) return resolveProject({ cwd: ctx.cwd, target, home, autoAttach: false }).root;
  const root = findProjectRoot(ctx.cwd);
  if (!root) {
    throw new MoError("E_PROJECT_UNBOUND", "当前目录不属于任何项目", {
      hint: "在项目里跑，或 --project <名称|路径>，或用 --all 扫全部",
    });
  }
  return root;
}
