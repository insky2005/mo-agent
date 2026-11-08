import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonAtomic, listFiles, readJsonSafe } from "./fsx.mjs";

/**
 * 收件箱：core 到主 Agent 的兜底通道（B9.3）。
 * 一个任务一个文件，pull 之后移到 pulled/，所以"拉取"天然幂等。
 */

export function inboxDir(home) {
  return path.join(home, "inbox");
}

export function pendingDir(home) {
  return path.join(inboxDir(home), "pending");
}

export function pulledDir(home) {
  return path.join(inboxDir(home), "pulled");
}

const NOTIFIABLE = new Set(["done", "blocked", "failed", "canceled", "expired"]);

const TYPE = {
  done: "task.done",
  blocked: "task.blocked",
  failed: "task.failed",
  canceled: "task.canceled",
  expired: "task.expired",
  approved: "task.confirmed",
  rejected: "task.confirm_rejected",
  stale: "task.confirm_stale",
};

/** 确认结果用单独文件，任务进入终态时清掉——否则同一张卡会占两条收件箱。 */
const CONFIRM_SUFFIX = "@confirm";

/**
 * 只有任务"需要人看一眼"时才落收件箱：完成、阻塞、失败。
 * 同一任务重复派单时覆盖旧条目（seq 递增），避免收件箱被重试刷屏。
 */
export function writeInbox({ home, taskId, project, projectRoot, title, status, verified, summary, reason, needs, deviations, source = "core" }) {
  if (!taskId || !NOTIFIABLE.has(status)) return null;
  const file = path.join(pendingDir(home), taskId + ".json");
  const previous = readJsonSafe(file, null);
  if (previous && previous.status === status && previous.summary === summary && previous.reason === reason) {
    return previous; // 一样的结果不重复提醒
  }
  const item = {
    v: 1,
    id: taskId,
    seq: (previous && Number(previous.seq)) ? Number(previous.seq) + 1 : 1,
    at: new Date().toISOString(),
    type: TYPE[status],
    status,
    taskId,
    project: project || null,
    projectRoot: projectRoot || null,
    title: title || null,
    verified: verified || "unverified",
    summary: summary || null,
    reason: reason || null,
    needs: Array.isArray(needs) ? needs : [],
    deviations: Array.isArray(deviations) ? deviations : [],
    source,
  };
  writeJsonAtomic(file, item);
  // 任务有结果了，之前那条「已批准、待派单」的提醒就没意义了
  try {
    fs.rmSync(path.join(pendingDir(home), taskId + CONFIRM_SUFFIX + ".json"), { force: true });
  } catch {
    // 删不掉不影响主流程
  }
  return item;
}

/**
 * 确认请求的结果也进收件箱（B2）：主 Agent 下一轮 pull 就能知道
 * "人已经批了 / 拒了"，不用等人再催一句。批准本身仍然只能由人做。
 */
export function writeConfirmInbox({ home, project, projectRoot, taskId, title, decision, requestId, channel }) {
  if (!taskId || !TYPE[decision]) return null;
  const file = path.join(pendingDir(home), taskId + CONFIRM_SUFFIX + ".json");
  const previous = readJsonSafe(file, null);
  if (previous && previous.requestId === requestId && previous.status === decision) return previous;
  const item = {
    v: 1,
    id: taskId + CONFIRM_SUFFIX,
    seq: (previous && Number(previous.seq)) ? Number(previous.seq) + 1 : 1,
    at: new Date().toISOString(),
    type: TYPE[decision],
    status: decision,
    taskId,
    requestId: requestId || null,
    channel: channel || null,
    project: project || null,
    projectRoot: projectRoot || null,
    title: title || null,
    verified: "unverified",
    summary: null,
    reason: decision,
    needs: [],
    deviations: [],
    source: "human",
  };
  writeJsonAtomic(file, item);
  return item;
}

export function listInbox(home) {
  const files = listFiles(pendingDir(home), ".json").sort();
  const items = [];
  const broken = [];
  for (const file of files) {
    const item = readJsonSafe(file, null);
    if (!item || !item.taskId) {
      broken.push(path.basename(file));
      continue;
    }
    items.push({ ...item, file });
  }
  return { items, broken };
}

/**
 * @returns {{items: object[], archived: number, broken: string[]}}
 */
export function pullInbox({ home, limit, peek = false, taskId }) {
  const listed = listInbox(home);
  let items = listed.items;
  if (taskId) items = items.filter((item) => item.taskId === taskId);
  items = items.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  if (limit > 0) items = items.slice(0, limit);

  let archived = 0;
  if (!peek) {
    ensureDir(pulledDir(home));
    for (const item of items) {
      try {
        fs.renameSync(item.file, path.join(pulledDir(home), path.basename(item.file)));
        archived += 1;
      } catch {
        // 归档失败不影响已经读到的内容，下次 pull 还能再看到
      }
    }
  }
  return { items: items.map(({ file, ...item }) => item), archived, broken: listed.broken };
}
