import { MoError } from "../../core/errors.mjs";
import { one, has } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { pullInbox, inboxDir } from "../lib/inbox.mjs";
import { parseDuration } from "../lib/envelope.mjs";

export function inboxCommand(ctx, args) {
  const sub = args.positional[0];
  if (sub !== "pull") {
    throw new MoError("E_USAGE", "未知子命令：inbox " + (sub || "") + "（可用：pull）");
  }
  return pullCommand(args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * mo inbox pull [--wait 60s]
 *
 * --wait 是"通用唤醒"：不依赖推送、不依赖 hook，任何 Agent 都能阻塞等。
 * 有消息立刻返回；到点没有就返回空，不算失败。
 */
async function pullCommand(args) {
  const home = moHome();
  const limitRaw = one(args.options, "limit");
  const limit = limitRaw ? Number(limitRaw) : 0;
  const peek = has(args.options, "peek");
  const taskId = one(args.options, "task");
  const options = { home, limit: Number.isFinite(limit) ? limit : 0, peek, taskId };

  let result = pullInbox(options);
  let waitedMs = 0;

  if (!result.items.length && has(args.options, "wait")) {
    const timeoutMs = parseDuration(one(args.options, "wait"), 30000);
    const startedAt = Date.now();
    while (!result.items.length && Date.now() - startedAt < timeoutMs) {
      await sleep(Math.min(500, Math.max(50, timeoutMs - (Date.now() - startedAt))));
      result = pullInbox(options);
    }
    waitedMs = Date.now() - startedAt;
  }

  const timeout = has(args.options, "wait") && !result.items.length;

  emit(
    args.options,
    {
      ok: true,
      dir: inboxDir(home),
      peek,
      count: result.items.length,
      archived: result.archived,
      items: result.items,
      broken: result.broken,
      waitedMs,
      timedOut: Boolean(timeout),
    },
    () => {
      if (!result.items.length) {
        return timeout ? "等了 " + Math.round(waitedMs / 1000) + "s，没有新消息" : "没有新消息";
      }
      const blocks = result.items.map((item) => {
        const head = [item.status, item.taskId, item.title].filter(Boolean).join(" · ");
        const lines = ["● " + head];
        if (item.verified && item.verified !== "unverified") lines.push("  验收   " + item.verified);
        if (item.reason && item.reason !== "receipt") lines.push("  原因   " + item.reason);
        if (item.summary) lines.push("  结论   " + item.summary);
        if (item.needs && item.needs.length) lines.push("  提问   " + item.needs.join("；"));
        if (item.deviations && item.deviations.length) lines.push("  偏差   " + item.deviations.join("；"));
        lines.push("  时间   " + item.at);
        lines.push("  查看   mo task status " + item.taskId);
        return lines.join("\n");
      });
      const tail = peek ? "（--peek：条目仍留在收件箱）" : result.archived ? "（已归档 " + result.archived + " 条）" : "";
      return [blocks.join("\n\n"), tail].filter(Boolean).join("\n");
    },
  );
  return 0;
}
