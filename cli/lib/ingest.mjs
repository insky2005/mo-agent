import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { RECEIPT_TO_STATE, assertTransition } from "../../core/tasks/model.mjs";
import { assertReceipt, validateReceipt } from "../../core/tasks/receipt.mjs";
import { loadCard, readReceipt, saveCard, appendEvent } from "./store.mjs";
import { hasVerifyFailure, runVerify, verifyPayload } from "./verify.mjs";
import { writeInbox } from "./inbox.mjs";
import { proposeFromPitfalls } from "./candidates.mjs";


const STATE_EVENT = {
  confirmed: "task.confirmed",
  dispatched: "task.dispatched",
  done: "task.completed",
  failed: "task.failed",
  blocked: "task.blocked",
  canceled: "task.canceled",
  expired: "task.expired",
};

export function transition({ home, root, card, to, payload = {}, actor = "core" }) {
  const { meta, body } = card;
  assertTransition(meta.status, to);
  meta.status = to;
  meta.updated = new Date().toISOString();
  saveCard(root, meta, body);
  const type = STATE_EVENT[to];
  if (type) appendEvent(home, { type, project: meta.project, taskId: meta.id, payload, actor });
  return card;
}

/**
 * 回执到达后的裁决：合法才算数，缺失/非法一律 blocked。
 */
export function ingest({ home, root, card, result }) {
  const { meta } = card;
  const receiptFile = cardReceiptFile(root, meta);

  if (result && result.timedOut) {
    const next = transition({ home, root, card, to: "blocked", payload: { reason: "timeout", outputTail: result.outputTail } });
    return summary(home, root, next, { status: "blocked", reason: "timeout", receipt: null, receiptFile, outputTail: result.outputTail });
  }

  if (result && result.spawnError) {
    const next = transition({
      home, root, card, to: "failed",
      payload: { reason: "dispatch_failed", message: String(result.spawnError.message || result.spawnError) },
    });
    return summary(home, root, next, { status: "failed", reason: "dispatch_failed", receipt: null, receiptFile, outputTail: result.outputTail });
  }

  const receipt = readReceipt(root, meta.id);
  if (!receipt) {
    const exitCode = result && result.code;
    const next = transition({
      home,
      root,
      card,
      to: "blocked",
      payload: { reason: "missing_receipt", exitCode, outputTail: result && result.outputTail },
    });
    return summary(home, root, next, {
      status: "blocked",
      reason: "missing_receipt",
      receipt: null,
      receiptFile,
      exitCode,
      outputTail: result && result.outputTail,
    });
  }

  if (receipt.__parseError) {
    const next = transition({ home, root, card, to: "blocked", payload: { reason: "bad_receipt", exitCode: result && result.code } });
    return summary(home, root, next, { status: "blocked", reason: "bad_receipt", receipt: null, receiptFile, exitCode: result && result.code, outputTail: result && result.outputTail });
  }

  const checked = validateReceipt(receipt, { taskId: meta.id });
  if (!checked.ok) {
    const next = transition({ home, root, card, to: "blocked", payload: { reason: "bad_receipt", errors: checked.errors } });
    return summary(home, root, next, { status: "blocked", reason: "bad_receipt", errors: checked.errors, receipt: checked.receipt, receiptFile });
  }

  appendEvent(home, { type: "receipt.received", project: meta.project, taskId: meta.id, actor: "worker", payload: { status: checked.receipt.status } });

  // B10.1：回执里的 pitfalls 只生成候选，不直接进知识库——等人裁决
  let proposals = { created: [], skipped: [] };
  try {
    proposals = proposeFromPitfalls({ home, card, receipt: checked.receipt });
    if (proposals.skipped.length) {
      process.stderr.write(
        "[W_MEMORY_INVALID] 回执里有 " + proposals.skipped.length + " 条避坑未收为候选：" +
          proposals.skipped.map((item) => item.title + "（" + item.errors.join("；") + "）").join("；") + "\n",
      );
    }
  } catch (error) {
    process.stderr.write("[W_MEMORY_CANDIDATE] 候选写入失败：" + (error && error.message ? error.message : error) + "\n");
  }

  // 回执说 done 只是"执行者认为做完了"；core 亲自跑验收后才决定终态。
  // 验收必须在 transition 之前算完：状态机没有 done → blocked。
  let target = RECEIPT_TO_STATE[checked.receipt.status];
  let reason = "receipt";
  let verified = "unverified";
  let verify = null;

  if (checked.receipt.status === "done") {
    verify = runVerify({ card, root });
    if (verify.results.length) {
      if (verify.ok) {
        verified = "verified";
      } else if (hasVerifyFailure(verify.results)) {
        target = "blocked";
        reason = "verify_failed";
        verified = "verify_failed";
      } else {
        target = "blocked";
        reason = "needs_human";
      }
    }
  }

  const payload = {
    reason,
    status: checked.receipt.status,
    summary: checked.receipt.summary,
    deviations: checked.receipt.deviations,
    pitfalls: checked.receipt.pitfalls,
  };
  if (verify && verify.results.length) payload.verify = verifyPayload(verify);

  const next = transition({ home, root, card, to: target, payload });
  next.meta.verified = verified;
  saveCard(root, next.meta, next.body);

  if (verify && verify.results.length && verified === "verified") {
    appendEvent(home, { type: "task.verified", project: meta.project, taskId: meta.id, payload: verifyPayload(verify) });
  } else if (verify && verify.results.length && verified === "verify_failed") {
    appendEvent(home, { type: "task.verify_failed", project: meta.project, taskId: meta.id, payload: verifyPayload(verify) });
  }

  return summary(home, root, next, {
    status: target,
    reason,
    receipt: checked.receipt,
    receiptFile,
    verify,
    candidates: proposals.created,
  });
}

function summary(home, root, card, extra) {
  const result = {
    taskId: card.meta.id,
    project: card.meta.project,
    status: card.meta.status,
    verified: card.meta.verified || "unverified",
    ...extra,
  };
  // B9.3 兜底：把"需要人看一眼"的结果落进收件箱，主 Agent 可以主动 pull
  try {
    writeInbox({
      home,
      projectRoot: root,
      taskId: card.meta.id,
      project: card.meta.project,
      title: card.meta.title,
      status: card.meta.status,
      verified: result.verified,
      summary: (extra.receipt && extra.receipt.summary) || null,
      reason: extra.reason || null,
    });
  } catch (error) {
    process.stderr.write("[W_INBOX_FAILED] 收件箱写入失败：" + (error && error.message ? error.message : error) + "\n");
  }
  return result;
}

function cardReceiptFile(root, meta) {
  if (meta.receipt) {
    return String(meta.receipt).startsWith("/") ? String(meta.receipt) : root + "/" + meta.receipt;
  }
  return root + "/.mo-agent/receipts/" + meta.id + ".json";
}

export function requireCardStatus(card, allowed, errorCode = "E_NOT_CONFIRMED") {
  if (!allowed.includes(card.meta.status)) {
    throw new MoError(errorCode, "任务当前状态是 " + card.meta.status + "，需要 " + allowed.join(" / "));
  }
}