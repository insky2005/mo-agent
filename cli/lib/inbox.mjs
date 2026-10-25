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
};

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
