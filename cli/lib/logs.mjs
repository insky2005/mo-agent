import fs from "node:fs";
import path from "node:path";
import { logPath } from "./paths.mjs";
import { ensureDir, exists } from "./fsx.mjs";

const OUTPUT_LIMIT = 2 * 1024 * 1024;

/** 每次派单都落一份完整日志：命令、环境摘要、输出、退出码、耗时。 */
export function writeRunLog({ root, taskId, command, cwd, timeoutMs, startedAt, result }) {
  const file = logPath(root, taskId);
  ensureDir(path.dirname(file));

  const header = [
    "# mo task " + taskId,
    "started:  " + new Date(startedAt).toISOString(),
    "command:  " + command,
    "cwd:      " + cwd,
    "timeout:  " + timeoutMs + "ms",
    "exit:     " + (result.spawnError ? "spawn-error: " + result.spawnError.message : result.code),
    "signal:   " + (result.signal || "-"),
    "timedout: " + Boolean(result.timedOut),
    "duration: " + (result.durationMs || 0) + "ms",
    result.outputTruncated ? "note:     输出超过 " + OUTPUT_LIMIT + " 字节，已截断" : null,
    "---",
    "",
  ].filter((line) => line !== null);

  const body = (result.output || result.outputTail || "").trimEnd();
  fs.writeFileSync(file, header.join("\n") + body + "\n", "utf8");
  return file;
}

export function readRunLog(root, taskId) {
  const file = logPath(root, taskId);
  if (!exists(file)) return null;
  return { file, text: fs.readFileSync(file, "utf8") };
}
