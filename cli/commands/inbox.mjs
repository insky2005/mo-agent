import { MoError } from "../../core/errors.mjs";
import { one, has } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { pullInbox, inboxDir } from "../lib/inbox.mjs";

export function inboxCommand(ctx, args) {
  const sub = args.positional[0];
  if (sub !== "pull") {
    throw new MoError("E_USAGE", "未知子命令：inbox " + (sub || "") + "（可用：pull）");
  }
  return pullCommand(args);
}

function pullCommand(args) {
  const home = moHome();
  const limitRaw = one(args.options, "limit");
  const limit = limitRaw ? Number(limitRaw) : 0;
  const peek = has(args.options, "peek");
  const taskId = one(args.options, "task");

  const result = pullInbox({ home, limit: Number.isFinite(limit) ? limit : 0, peek, taskId });

  emit(
    args.options,
    { ok: true, dir: inboxDir(home), peek, count: result.items.length, archived: result.archived, items: result.items, broken: result.broken },
    () => {
      if (!result.items.length) return "没有新消息";
      const blocks = result.items.map((item) => {
        const head = [item.status, item.taskId, item.title].filter(Boolean).join(" · ");
        const lines = ["● " + head];
        if (item.verified && item.verified !== "unverified") lines.push("  验收   " + item.verified);
        if (item.reason && item.reason !== "receipt") lines.push("  原因   " + item.reason);
        if (item.summary) lines.push("  结论   " + item.summary);
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
