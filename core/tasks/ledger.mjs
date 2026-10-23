/**
 * 账本事件：只负责构造与筛选，落盘由调用方完成。
 * 见 docs/spec/workbench-flow.md §10。
 */
export const EVENT_TYPES = [
  "task.created",
  "task.confirmed",
  "task.dispatched",
  "task.completed",
  "task.failed",
  "task.blocked",
  "task.canceled",
  "task.expired",
  "receipt.received",
  "receipt.amended",
  "memory.proposed",
  "memory.accepted",
];

export function makeEvent({ type, project, taskId, actor = "core", payload = {}, machine = "", at = new Date().toISOString() }) {
  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`未知事件类型：${type}`);
  }
  return { v: 1, at, machine, project, taskId, type, actor, payload };
}

export function filterEvents(events, query = {}) {
  const { project, taskId, type, since, until } = query;
  return events.filter((event) => {
    if (!event || event.v !== 1) return false;
    if (project && event.project !== project) return false;
    if (taskId && event.taskId !== taskId) return false;
    if (type && !event.type.startsWith(type)) return false;
    if (since && new Date(event.at) < new Date(since)) return false;
    if (until && new Date(event.at) > new Date(until)) return false;
    return true;
  });
}

export function summarize(events) {
  const byType = {};
  for (const event of events) byType[event.type] = (byType[event.type] || 0) + 1;
  return { total: events.length, byType };
}
