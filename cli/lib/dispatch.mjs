import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { buildEnvelope, parseDuration } from "./envelope.mjs";
import { runExecutor } from "./runner.mjs";
import { appendEvent, loadCard } from "./store.mjs";
import { ingest, transition } from "./ingest.mjs";

export function resolveReceiptFile(root, meta) {
  if (meta.receipt) {
    return String(meta.receipt).startsWith("/") ? String(meta.receipt) : path.join(root, String(meta.receipt));
  }
  return path.join(root, ".mo-agent", "receipts", meta.id + ".json");
}

/**
 * 派单：确认 → 派发 → 起进程 → 收执 → 定状态。
 * 返回结构化结果，不打印。
 */
export async function dispatchTask({ home, root, taskId, exec, timeout }) {
  const card = loadCard(root, taskId);
  const { meta } = card;

  if (meta.status === "draft") {
    throw new MoError("E_NOT_CONFIRMED", "任务卡还没确认，先执行 mo task confirm " + taskId + "（确认权属于人）");
  }
  if (meta.status !== "confirmed" && meta.status !== "running" && meta.status !== "dispatched") {
    throw new MoError("E_NOT_CONFIRMED", "任务当前状态是 " + meta.status + "，不能派单");
  }

  const command = exec || meta.exec;
  if (!command) {
    throw new MoError("E_NO_EXECUTOR", "没有执行者：用 --exec 指定命令，或在建卡时 --exec", {
      hint: "例如 --exec \"claude -p\" 或 --exec \"node ./scripts/run-task.mjs\"",
    });
  }

  if (meta.status === "confirmed") {
    transition({ home, root, card, to: "dispatched", payload: { assignee: meta.assignee || "auto", exec: String(command) } });
    transition({ home, root, card, to: "running", payload: {} });
  }

  const receiptFile = resolveReceiptFile(root, meta);
  const envelope = buildEnvelope({ meta, body: card.body, root, receiptFile });

  const env = {
    ...process.env,
    MO_TASK_ID: meta.id,
    MO_PROJECT: meta.project,
    MO_PROJECT_ROOT: root,
    MO_RECEIPT: receiptFile,
  };

  const timeoutMs = timeout !== undefined ? parseDuration(timeout, 45 * 60 * 1000) : parseDuration(meta.timeout, 45 * 60 * 1000);

  const result = await runExecutor({
    command: String(command),
    cwd: root,
    env,
    input: envelope,
    timeoutMs,
  });

  return ingest({ home, root, card: loadCard(root, taskId), result });
}
