import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { cardDigest, decide, expire, isExpired, isStale, makeRequest } from "../../core/manager/approval.mjs";
import { ensureDir, listFiles, readJsonSafe, writeJsonAtomic } from "./fsx.mjs";
import { loadCard, appendEvent } from "./store.mjs";
import { transition } from "./ingest.mjs";
import { newApprovalId } from "./ids.mjs";

/**
 * 授权请求的落盘队列：唯一真源。
 * 终端与手机都往这里写结果，daemon 不在也不会丢。
 */

export function approvalsDir(home) {
  return path.join(home, "approvals");
}

function requestFile(home, id) {
  return path.join(approvalsDir(home), id + ".json");
}

export function listRequests(home) {
  return listFiles(approvalsDir(home), ".json")
    .map((file) => readJsonSafe(file, null))
    .filter((item) => item && item.id)
    .sort((left, right) => String(right.at).localeCompare(String(left.at)));
}

export function readRequest(home, id) {
  if (!/^a_[0-9A-Z]+$/.test(String(id || ""))) return null;
  return readJsonSafe(requestFile(home, id), null);
}

export function saveRequest(home, request) {
  ensureDir(approvalsDir(home));
  writeJsonAtomic(requestFile(home, request.id), request);
  return request;
}

/** 取这张卡最新的待批请求（顺带把过期的标记掉） */
export function pendingForTask(home, taskId) {
  const pending = listRequests(home).filter((item) => item.taskId === taskId && item.status === "pending");
  const live = [];
  for (const item of pending) {
    if (isExpired(item)) {
      saveRequest(home, expire(item));
      continue;
    }
    live.push(item);
  }
  return live.sort((left, right) => String(right.at).localeCompare(String(left.at)))[0] || null;
}

/**
 * 发起请求。同卡已有 pending 时复用，避免 Agent 反复 confirm 刷一堆。
 */
export function requestConfirmation({ home, root, card, requestedBy, ttlMs }) {
  const existing = pendingForTask(home, card.meta.id);
  if (existing) return { request: existing, created: false };

  if (card.meta.status !== "draft") {
    throw new MoError("E_NOT_CONFIRMED", "只有 draft 的卡需要确认，当前状态是 " + card.meta.status, {
      hint: card.meta.status === "confirmed" ? "已经确认过了，直接派发：mo task dispatch " + card.meta.id : undefined,
    });
  }

  const request = makeRequest({
    id: newApprovalId(),
    taskId: card.meta.id,
    project: card.meta.project,
    projectRoot: root,
    title: card.meta.title,
    digest: cardDigest(card),
    requestedBy: requestedBy || { actor: "agent", from: process.env.MO_AGENT_ID || null },
    ttlMs,
  });
  saveRequest(home, request);
  appendEvent(home, {
    type: "task.confirm_requested",
    project: card.meta.project,
    taskId: card.meta.id,
    actor: "agent",
    payload: { requestId: request.id, cardHash: request.cardHash, expiresAt: request.expiresAt, from: request.requestedBy.from || null },
  });
  return { request, created: true };
}

/**
 * 施加一个决定。批准时校验指纹：卡变了就作废（stale），不写 confirmed。
 */
export function applyDecision({ home, root, request, status, channel, note }) {
  const card = loadCard(root, request.taskId);
  const currentDigest = cardDigest(card);

  if (status === "approved" && isStale(request, currentDigest)) {
    const stale = saveRequest(home, decide(request, { status: "stale", channel, note: "卡片内容在批准前发生变化" }));
    throw new MoError("E_CARD_CHANGED", "卡片内容已经变了，这次批准作废", {
      hint: "让用户重新确认这张卡：mo task confirm " + request.taskId,
      details: { requestId: stale.id },
    });
  }

  const decided = saveRequest(home, decide(request, { status, channel, note }));

  if (status === "approved") {
    if (card.meta.status === "draft") {
      transition({
        home,
        root,
        card,
        to: "confirmed",
        actor: "human",
        payload: { requestId: decided.id, channel, cardHash: decided.cardHash },
      });
    }
  } else if (status === "rejected") {
    appendEvent(home, {
      type: "task.confirm_rejected",
      project: card.meta.project,
      taskId: card.meta.id,
      actor: "human",
      payload: { requestId: decided.id, channel, note: note || null },
    });
  }

  return decided;
}

/** 懒清理：把过期的请求标掉，并让卡走 expired（B4.4） */
export function expireOverdue({ home, root }) {
  const expired = [];
  for (const item of listRequests(home)) {
    if (!isExpired(item)) continue;
    saveRequest(home, expire(item));
    expired.push(item.id);
    try {
      const card = loadCard(root, item.taskId);
      if (card.meta.status === "draft") {
        transition({ home, root, card, to: "expired", actor: "core", payload: { requestId: item.id, reason: "confirm_timeout" } });
      }
    } catch {
      // 卡片可能已被删除或已推进，过期标记仍然有效
    }
  }
  return expired;
}
