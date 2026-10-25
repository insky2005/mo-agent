import fs from "node:fs";
import { listCards } from "./store.mjs";
import { transition } from "./ingest.mjs";
import { writeInbox } from "./inbox.mjs";
import { expireOverdue } from "./approvals.mjs";
import { listProjects } from "./project.mjs";
import { findOverdue, parseTimeoutMs } from "../../core/tasks/watch.mjs";

/**
 * watchdog：把"超时还没回执"的卡转成 blocked(timeout)，并落收件箱。
 *
 * 只改状态、不杀进程——会话型的窗口不归 mo 管，标 blocked 只是"这卡该人看了"。
 */
export function rootsForWatch({ home, cwd, project, all = false }) {
  if (all) {
    const paths = listProjects(home).flatMap((entry) => entry.paths || []);
    return [...new Set(paths)].filter((item) => fs.existsSync(item));
  }
  if (project) return [project];
  return cwd ? [cwd] : [];
}

export function runWatchdog({ home, roots = [], now = Date.now(), dryRun = false }) {
  const summary = { checked: 0, overdue: [], expiredApprovals: [], roots: [...roots] };

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const cards = listCards(root);
    summary.checked += cards.length;

    for (const item of findOverdue(cards, { now, timeoutFor: (card) => parseTimeoutMs(card.meta.timeout) })) {
      const minutes = Math.max(1, Math.round(item.elapsedMs / 60000));
      const isSession = Boolean(item.card.meta.session);
      summary.overdue.push({
        taskId: item.card.meta.id,
        title: item.card.meta.title,
        elapsedMs: item.elapsedMs,
        session: isSession,
        root,
      });

      if (dryRun) continue;

      transition({
        home,
        root,
        card: item.card,
        to: "blocked",
        actor: "core",
        payload: { reason: "timeout", elapsedMs: item.elapsedMs, session: isSession ? "session" : "headless" },
      });

      writeInbox({
        home,
        taskId: item.card.meta.id,
        project: item.card.meta.project,
        projectRoot: root,
        title: item.card.meta.title,
        status: "blocked",
        verified: "unverified",
        summary:
          "超过 " + minutes + " 分钟没有回执" + (isSession ? "（会话型；窗口可能还开着，去看一眼）" : ""),
        reason: "timeout",
      });
    }

    if (!dryRun) {
      const expired = expireOverdue({ home, root });
      summary.expiredApprovals.push(...expired);
    }
  }

  return summary;
}
