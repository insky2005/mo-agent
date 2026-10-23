import { MoError } from "../../core/errors.mjs";
import { one } from "../lib/args.mjs";
import { moHome } from "../lib/paths.mjs";
import { resolveProject } from "../lib/project.mjs";
import { runDispatch } from "./task.mjs";

export function runCommand(ctx, args) {
  const resolved = resolveProject({ cwd: ctx.cwd, target: one(args.options, "project"), home: moHome() });
  const taskId = args.positional[0] || one(args.options, "task");
  if (!taskId) throw new MoError("E_USAGE", "缺少 taskId：mo run <taskId>");
  return runDispatch(args, { home: moHome(), root: resolved.root, taskId });
}
