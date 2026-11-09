import { MoError } from "../../core/errors.mjs";
import { receiptCommand } from "./receipt.mjs";
import { watchdogCommand } from "./watchdog.mjs";
import { mcpCommand } from "./mcp.mjs";
import { completionCommand } from "./completion.mjs";
import { memoryCommand } from "./memory.mjs";
import { noteCommand } from "./note.mjs";

/**
 * mo internal —— 机器用 / 排障用的命令（E5）。
 *
 * 它们不是"日常操作"，摆在主 help 里只会让命令面显得更乱；
 * 顶层旧名字（receipt / watchdog / mcp / completion）继续可用，属于别名。
 */
const TABLE = {
  receipt: receiptCommand,
  watchdog: watchdogCommand,
  mcp: mcpCommand,
  completion: completionCommand,
  // 一次性迁移命令：从 mo memory migrate 收过来
  "memory-migrate": (ctx, args) => memoryCommand(ctx, { positional: ["migrate", ...args.positional], options: args.options }),
  // 过程文档：MCP 的 note_write 落到这里
  "note-write": (ctx, args) => noteCommand(ctx, { positional: ["write", ...args.positional], options: args.options }),
};

export function internalCommand(ctx, args) {
  const sub = args.positional[0];
  const handler = TABLE[sub];
  if (!handler) {
    throw new MoError("E_USAGE", "未知内部命令：internal " + (sub || "") + "（可用：receipt / watchdog / mcp / completion / memory-migrate）");
  }
  return handler(ctx, { positional: args.positional.slice(1), options: args.options });
}
