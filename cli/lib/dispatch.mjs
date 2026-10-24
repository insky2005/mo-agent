import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { buildEnvelope, parseDuration } from "./envelope.mjs";
import { runExecutor } from "./runner.mjs";
import { ensureDir } from "./fsx.mjs";
import { receiptDir } from "./paths.mjs";
import { appendEvent, loadCard } from "./store.mjs";
import { ingest, transition } from "./ingest.mjs";
import { writeRunLog } from "./logs.mjs";
import { recallKnowledge, cardQuery } from "./knowledge.mjs";
import { formatKnowledgeBlock } from "../../core/knowledge/recall.mjs";

/**
 * 召回是"尽力而为"：读不到知识库不能挡住派单，但必须吵一声（B10.5 / I9）。
 */
function recallForDispatch({ home, card }) {
  try {
    const recalled = recallKnowledge({ home, query: cardQuery(card) });
    return {
      block: formatKnowledgeBlock(recalled.matched),
      info: {
        ok: true,
        dir: recalled.dir,
        count: recalled.matched.length,
        total: recalled.total,
        ids: recalled.matched.map((entry) => entry.id),
        warnings: recalled.warnings,
      },
    };
  } catch (error) {
    if (!error || error.code !== "E_MEMORY_UNAVAILABLE") throw error;
    process.stderr.write("[W_MEMORY_UNAVAILABLE] " + error.message + "（本次没有注入知识）\n");
    return { block: "", info: { ok: false, error: { code: error.code, message: error.message } } };
  }
}

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
export async function dispatchTask({ home, root, taskId, exec, timeout, actor = "core" }) {
  const card = loadCard(root, taskId);
  const { meta } = card;

  if (meta.status === "draft") {
    throw new MoError("E_NOT_CONFIRMED", "任务卡还没确认，先执行 mo task confirm " + taskId + "（确认权属于人）");
  }
  const dispatchable = ["confirmed", "dispatched", "running", "blocked"];
  if (!dispatchable.includes(meta.status)) {
    throw new MoError("E_NOT_CONFIRMED", "任务当前状态是 " + meta.status + "，不能派单");
  }

  const command = exec || meta.exec;
  if (!command) {
    throw new MoError("E_NO_EXECUTOR", "没有执行者：用 --exec 指定命令，或在建卡时 --exec", {
      hint: "例如 --exec \"claude -p\" 或 --exec \"node ./scripts/run-task.mjs\"",
    });
  }

  if (meta.status === "blocked") {
    // 重试：blocked 是"可恢复"的，回到 running 再跑一次
    transition({ home, root, card, to: "running", payload: { retry: true, exec: String(command) }, actor });
  } else if (meta.status === "confirmed") {
    transition({ home, root, card, to: "dispatched", payload: { assignee: meta.assignee || "auto", exec: String(command) }, actor });
    transition({ home, root, card, to: "running", payload: {}, actor });
  }

  const receiptFile = resolveReceiptFile(root, meta);
  // 回执目录由 core 准备好：执行者只该关心"写这个文件"，不该操心建目录
  ensureDir(receiptDir(root));
  const knowledge = recallForDispatch({ home, card });
  const envelope = buildEnvelope({
    meta,
    body: card.body,
    root,
    receiptFile,
    knowledge: knowledge.block,
  });

  const env = {
    ...process.env,
    MO_TASK_ID: meta.id,
    MO_PROJECT: meta.project,
    MO_PROJECT_ROOT: root,
    MO_RECEIPT: receiptFile,
  };

  const timeoutMs = timeout !== undefined ? parseDuration(timeout, 45 * 60 * 1000) : parseDuration(meta.timeout, 45 * 60 * 1000);
  const startedAt = Date.now();

  const result = await runExecutor({
    command: String(command),
    cwd: root,
    env,
    input: envelope,
    timeoutMs,
  });

  // 不管成败都留全量日志，调试/优化时有据可查
  const logFile = writeRunLog({
    root,
    taskId,
    command: String(command),
    cwd: root,
    timeoutMs,
    startedAt,
    result,
  });

  const summary = ingest({ home, root, card: loadCard(root, taskId), result });
  return { ...summary, executor: String(command), logFile, knowledge: knowledge.info };
}
