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
import { launchTerminal, sessionPaths, writeSessionAssets } from "./session-launch.mjs";
import { resolveTerminal } from "./terminals.mjs";

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

/**
 * 卡上的 workdir 是相对项目根的；越界直接拒绝（B5.11）。
 */
export function resolveWorkdir(root, meta) {
  const relative = meta && meta.workdir ? String(meta.workdir) : ".";
  const absolute = path.resolve(root, relative);
  const back = path.relative(root, absolute);
  if (back.startsWith("..") || path.isAbsolute(back)) {
    throw new MoError("E_SCOPE", "workdir 越出项目根：" + relative, {
      hint: "只能落在项目目录内，例如 . 或 app/web",
    });
  }
  return absolute;
}

/**
 * 会话型派单：不 spawn 子进程，而是在新终端窗口里跑交互式 CLI。
 * 人能看到执行过程；dispatch 立即返回，结果靠回执文件（与无头模式的唯一区别）。
 */
export function dispatchSession({ home, root, taskId, worker, actor = "agent", env = process.env }) {
  const card = loadCard(root, taskId);
  const { meta } = card;

  if (meta.status === "draft") {
    throw new MoError("E_NOT_CONFIRMED", "任务卡还没确认，先执行 mo task confirm " + taskId + "（确认权属于人）");
  }
  if (!["confirmed", "dispatched", "running", "blocked"].includes(meta.status)) {
    throw new MoError("E_NOT_CONFIRMED", "任务当前状态是 " + meta.status + "，不能派单");
  }
  if (!worker || !worker.command) {
    throw new MoError("E_NO_EXECUTOR", "会话型 worker 需要有启动命令");
  }

  const terminal = resolveTerminal({ home, env });
  const workdir = resolveWorkdir(root, meta);
  const dryRun = terminal.kind === "print";
  // 先确认有终端可开，再改状态——否则会留下"running 但窗口没起来"的卡
  if (terminal.kind === "none" && !dryRun) {
    throw new MoError("E_NO_TERMINAL", "没有可用的终端，无法开启会话型 worker", {
      hint: "mo terminal list 看可用终端，mo terminal use iterm 设默认；服务器/CI 请用无头 worker",
    });
  }

  if (meta.status === "blocked") {
    transition({ home, root, card, to: "running", payload: { retry: true, session: terminal.name }, actor });
  } else if (meta.status === "confirmed") {
    transition({
      home,
      root,
      card,
      to: "dispatched",
      payload: { assignee: worker.name || "auto", session: terminal.name, exec: worker.command },
      actor,
    });
    transition({ home, root, card, to: "running", payload: { session: terminal.name }, actor });
  }

  const receiptFile = resolveReceiptFile(root, meta);
  ensureDir(receiptDir(root));
  const knowledge = recallForDispatch({ home, card });
  const envelope = buildEnvelope({
    meta,
    body: card.body,
    root,
    receiptFile,
    knowledge: knowledge.block,
    workdir,
  });
  const files = sessionPaths(root, taskId);
  const prompt =
    "请阅读 " + files.envelope + " 并执行其中的任务卡，完成后把回执写到 " + receiptFile + "，并输出一行 RECEIPT_WRITTEN " + receiptFile;

  writeSessionAssets({
    projectRoot: root,
    cwd: workdir,
    taskId,
    title: meta.title,
    command: worker.command,
    prompt,
    receipt: receiptFile,
    envelopeText: envelope,
  });

  const launched = launchTerminal({ spec: terminal, script: files.script });

  return {
    taskId,
    project: meta.project,
    status: "running",
    verified: "unverified",
    reason: "session",
    session: {
      terminal: terminal.name,
      kind: launched.kind,
      reason: terminal.reason,
      launched: launched.launched,
      script: files.script,
      envelope: files.envelope,
    },
    knowledge: knowledge.info,
  };
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
    throw new MoError("E_NO_EXECUTOR", "这张卡没有执行者，也没有默认执行者", {
      hint: "mo worker use <名称> 设默认，或派单时 --worker/--exec 指定",
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
    cwd: resolveWorkdir(root, meta),
    env,
    input: envelope,
    timeoutMs,
  });

  // 不管成败都留全量日志，调试/优化时有据可查
  const logFile = writeRunLog({
    root,
    taskId,
    command: String(command),
    cwd: resolveWorkdir(root, meta),
    timeoutMs,
    startedAt,
    result,
  });

  const summary = ingest({ home, root, card: loadCard(root, taskId), result });
  return { ...summary, executor: String(command), logFile, knowledge: knowledge.info };
}
