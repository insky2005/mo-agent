import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { RECEIPT_TO_STATE, assertTransition } from "../../core/tasks/model.mjs";
import { assertReceipt, validateReceipt } from "../../core/tasks/receipt.mjs";
import { loadCard, readReceipt, saveCard, appendEvent } from "./store.mjs";

const STATE_EVENT = {
  confirmed: "task.confirmed",
  dispatched: "task.dispatched",
  done: "task.completed",
  failed: "task.failed",
  blocked: "task.blocked",
  canceled: "task.canceled",
  expired: "task.expired",
};

export function transition({ home, root, card, to, payload = {} }) {
  const { meta, body } = card;
  assertTransition(meta.status, to);
  meta.status = to;
  meta.updated = new Date().toISOString();
  saveCard(root, meta, body);
  const type = STATE_EVENT[to];
  if (type) appendEvent(home, { type, project: meta.project, taskId: meta.id, payload });
  return card;
}

/**
 * 回执到达后的裁决：合法才算数，缺失/非法一律 blocked。
 */
export function ingest({ home, root, card, result }) {
  const { meta } = card;
  const receiptFile = cardReceiptFile(root, meta);

  if (result && result.timedOut) {
    const next = transition({ home, root, card, to: "blocked", payload: { reason: "timeout" } });
    return summary(next, { status: "blocked", reason: "timeout", receipt: null, receiptFile });
  }

  if (result && result.spawnError) {
    const next = transition({
      home, root, card, to: "failed",
      payload: { reason: "dispatch_failed", message: String(result.spawnError.message || result.spawnError) },
    });
    return summary(next, { status: "failed", reason: "dispatch_failed", receipt: null, receiptFile });
  }

  const receipt = readReceipt(root, meta.id);
  if (!receipt) {
    const next = transition({ home, root, card, to: "blocked", payload: { reason: "missing_receipt", exitCode: result && result.code } });
    return summary(next, { status: "blocked", reason: "missing_receipt", receipt: null, receiptFile });
  }

  if (receipt.__parseError) {
    const next = transition({ home, root, card, to: "blocked", payload: { reason: "bad_receipt" } });
    return summary(next, { status: "blocked", reason: "bad_receipt", receipt: null, receiptFile });
  }

  const checked = validateReceipt(receipt, { taskId: meta.id });
  if (!checked.ok) {
    const next = transition({ home, root, card, to: "blocked", payload: { reason: "bad_receipt", errors: checked.errors } });
    return summary(next, { status: "blocked", reason: "bad_receipt", errors: checked.errors, receipt: checked.receipt, receiptFile });
  }

  appendEvent(home, { type: "receipt.received", project: meta.project, taskId: meta.id, actor: "executor", payload: { status: checked.receipt.status } });

  const target = RECEIPT_TO_STATE[checked.receipt.status];
  const next = transition({
    home, root, card, to: target,
    payload: {
      reason: "receipt",
      status: checked.receipt.status,
      summary: checked.receipt.summary,
      deviations: checked.receipt.deviations,
      pitfalls: checked.receipt.pitfalls,
    },
  });
  next.meta.verified = "unverified";
  saveCard(root, next.meta, next.body);
  return summary(next, {
    status: target,
    reason: "receipt",
    receipt: checked.receipt,
    receiptFile,
  });
}

function summary(card, extra) {
  return {
    taskId: card.meta.id,
    project: card.meta.project,
    status: card.meta.status,
    verified: card.meta.verified || "unverified",
    ...extra,
  };
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
