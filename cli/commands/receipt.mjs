import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { validateReceipt } from "../../core/tasks/receipt.mjs";
import { one } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { loadCard, readReceipt, writeReceipt } from "../lib/store.mjs";
import { resolveProject } from "../lib/project.mjs";
import { ingest } from "../lib/ingest.mjs";

const TERMINAL = ["done", "failed", "canceled", "expired"];

function readInput(file) {
  if (!file || file === true) return fs.readFileSync(0, "utf8");
  if (file === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(file, "utf8");
}

/** mo receipt submit|apply */
export function receiptCommand(ctx, args) {
  const sub = args.positional[0];
  if (!["submit", "apply"].includes(sub)) {
    throw new MoError("E_USAGE", "未知子命令：receipt " + (sub || "") + "（可用：submit / apply）");
  }

  const resolved = resolveProject({ cwd: ctx.cwd, target: one(args.options, "project"), home: moHome() });
  const taskId = args.positional[1] || one(args.options, "task");
  if (!taskId) throw new MoError("E_USAGE", "缺少 taskId");

  if (sub === "submit") return submit(args, resolved.root, taskId);
  return apply(args, resolved.root, taskId);
}

function submit(args, root, taskId) {
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

  loadCard(root, taskId);
  writeReceipt(root, taskId, checked.receipt);
  const file = root + "/.mo-agent/receipts/" + taskId + ".json";
  emit(args.options, { ok: true, taskId, path: file }, () =>
    ["✓ 已写入回执", "", "  id     " + taskId, "  回执   " + file, "", "下一步（应用）：mo receipt apply " + taskId].join("\n"));
  return 0;
}

function apply(args, root, taskId) {
  const card = loadCard(root, taskId);
  if (TERMINAL.includes(card.meta.status)) {
    throw new MoError("E_USAGE", "任务已经是 " + card.meta.status + "，不需要应用回执", {
      hint: card.meta.status === "done" ? "要重跑验收用：mo task verify " + taskId : undefined,
    });
  }

  const receipt = readReceipt(root, taskId);
  if (!receipt) {
    throw new MoError("E_NO_RECEIPT", "没有找到回执：" + root + "/.mo-agent/receipts/" + taskId + ".json", {
      hint: "先用 mo receipt submit 写入，或让执行者写到这个路径",
    });
  }

  const checked = validateReceipt(receipt, { taskId });
  if (!checked.ok) {
    throw new MoError("E_BAD_RECEIPT", checked.errors.join("；"), { errors: checked.errors });
  }

  const result = ingest({
    home: moHome(),
    root,
    card,
    result: { code: 0, timedOut: false, spawnError: null, outputTail: "" },
  });

  emit(args.options, { ok: result.status === "done", ...result }, () => {
    const lines = [
      result.status === "done" ? "✓ 已应用回执" : "⚠ 回执已应用，但任务没完成",
      "",
      "  id     " + taskId,
      "  状态   " + result.status,
      "  验收   " + result.verified,
    ];
    if (result.reason && result.reason !== "receipt") lines.push("  原因   " + result.reason);
    if (result.errors) lines.push("  问题   " + result.errors.join("；"));
    return lines.join("\n");
  });
  return result.status === "done" ? 0 : 1;
}