import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { parseCard, renderCard } from "../../core/tasks/card.mjs";
import { makeEvent } from "../../core/tasks/ledger.mjs";
import { ensureDir, appendLine, readText, writeAtomic, listFiles } from "./fsx.mjs";
import { cardPath, receiptPath, ledgerDir, ledgerFile, taskDir, receiptDir } from "./paths.mjs";
import { machineName } from "./project.mjs";

export function loadCard(root, taskId) {
  const file = cardPath(root, taskId);
  if (!fs.existsSync(file)) {
    throw new MoError("E_CARD_INVALID", "任务卡不存在：" + file, { taskId });
  }
  return parseCard(readText(file));
}

export function saveCard(root, meta, body) {
  ensureDir(taskDir(root));
  writeAtomic(cardPath(root, meta.id), renderCard({ meta, body }));
}

export function listCards(root) {
  return listFiles(taskDir(root), ".md")
    .map((file) => {
      try {
        return parseCard(readText(file));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function writeReceipt(root, taskId, receipt) {
  ensureDir(receiptDir(root));
  writeAtomic(receiptPath(root, taskId), JSON.stringify(receipt, null, 2) + "\n");
}

export function readReceipt(root, taskId) {
  const file = receiptPath(root, taskId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(readText(file));
  } catch {
    return { __parseError: true };
  }
}

export function appendEvent(home, event) {
  ensureDir(ledgerDir(home));
  const record = makeEvent({
    type: event.type,
    project: event.project,
    taskId: event.taskId,
    actor: event.actor || "core",
    payload: event.payload || {},
    machine: machineName(),
  });
  appendLine(ledgerFile(home), JSON.stringify(record));
  return record;
}

export function readEvents(home, options = {}) {
  const months = options.months || 2;
  const files = listLedgerFiles(home).slice(-months);
  const events = [];
  for (const file of files) {
    for (const line of readText(file).split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 坏行跳过：账本是流水，不因一行损坏整体不可读
      }
    }
  }
  return events;
}

function listLedgerFiles(home) {
  return listFiles(ledgerDir(home), ".jsonl").sort();
}

export function tailEvents(home, taskId, limit = 5) {
  return readEvents(home)
    .filter((event) => event.taskId === taskId)
    .slice(-limit);
}
