import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { validateReceipt } from "../../core/tasks/receipt.mjs";
import { one } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { loadCard, writeReceipt } from "../lib/store.mjs";
import { resolveProject } from "../lib/project.mjs";

function readInput(file) {
  if (!file || file === true) return fs.readFileSync(0, "utf8");
  if (file === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(file, "utf8");
}

export function receiptCommand(ctx, args) {
  const sub = args.positional[0];
  if (sub !== "submit") {
    throw new MoError("E_USAGE", "未知子命令：receipt " + (sub || "") + "（可用：submit）");
  }
  const resolved = resolveProject({ cwd: ctx.cwd, target: one(args.options, "project"), home: moHome() });
  const taskId = args.positional[1] || one(args.options, "task");
  if (!taskId) throw new MoError("E_USAGE", "缺少 taskId");

  const raw = readInput(one(args.options, "file"));
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    throw new MoError("E_BAD_RECEIPT", "回执不是合法 JSON");
  }

  const checked = validateReceipt(receipt, { taskId });
  if (!checked.ok) {
    throw new MoError("E_BAD_RECEIPT", checked.errors.join("；"), { errors: checked.errors });
  }

  if (one(args.options, "dry-run")) {
    emit(args.options, { ok: true, dryRun: true, taskId, receipt: checked.receipt }, "回执合法（未写入）");
    return 0;
  }

  loadCard(resolved.root, taskId);
  writeReceipt(resolved.root, taskId, checked.receipt);
  emit(args.options, { ok: true, taskId, path: resolved.root + "/.mo-agent/receipts/" + taskId + ".json" },
    "已写入回执 " + taskId + "（status=" + checked.receipt.status + "）");
  return 0;
}
