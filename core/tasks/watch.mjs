/**
 * watchdog 的判定：纯函数，不碰文件系统。
 *
 * 只回答一个问题：哪些卡"已经超过自己声明的 timeout 还没有结果"。
 * 不做重试、不杀进程、不猜它是不是还在干活。
 */

export const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/** "45m" / "2h" / "90s" → 毫秒；解析不了就用默认值 */
export function parseTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  if (value === undefined || value === null || value === true) return fallback;
  const matched = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(value).trim());
  if (!matched) return fallback;
  const amount = Number(matched[1]);
  const unit = (matched[2] || "m").toLowerCase();
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60 * 1000 : 60 * 60 * 1000;
  return Math.round(amount * factor);
}

/**
 * @param {{meta: {id: string, status: string, updated?: string, created?: string, timeout?: string}}[]} cards
 * @param {{now?: number, timeoutFor?: (card: object) => number}} options
 * @returns {{card: object, elapsedMs: number, timeoutMs: number}[]}
 */
export function findOverdue(cards, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const timeoutFor = typeof options.timeoutFor === "function" ? options.timeoutFor : (card) => parseTimeoutMs(card.meta.timeout);
  const overdue = [];

  for (const card of cards) {
    const status = card.meta && card.meta.status;
    if (status !== "running" && status !== "dispatched") continue;
    const since = Date.parse(card.meta.updated || card.meta.created || "");
    if (!Number.isFinite(since)) continue;
    const limit = timeoutFor(card);
    const elapsedMs = now - since;
    if (elapsedMs < limit) continue;
    overdue.push({ card, elapsedMs, timeoutMs: limit });
  }

  return overdue;
}
