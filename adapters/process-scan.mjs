import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 通用进程发现（L1 层）：只回答「谁在跑」，不关心它在干什么。
 * 这是唯一能覆盖「用户自己启动的任意 Agent」的手段。
 */
export async function scanProcesses(profiles) {
  const active = (profiles || []).filter((p) => p.enabled !== false);
  if (!active.length) return [];
  let stdout = "";
  try {
    // macOS / Linux: BSD 与 GNU ps 都支持这组字段
    const result = await run("ps", ["-axo", "pid=,ppid=,etime=,command="], { maxBuffer: 8 * 1024 * 1024 });
    stdout = result.stdout || "";
  } catch (error) {
    return [];
  }
  const found = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, elapsed, command] = m;
    for (const profile of active) {
      const patterns = (profile.process && profile.process.match) || [];
      for (const pattern of patterns) {
        let re;
        try {
          re = new RegExp(pattern);
        } catch (error) {
          continue;
        }
        if (re.test(command)) {
          found.push({ pid: Number(pid), ppid: Number(ppid), elapsed, command: command.slice(0, 300), agent: profile.id, label: profile.label });
          break;
        }
      }
    }
  }
  // 去掉我们自己的扫描进程
  return found.filter((entry) => !/process-scan|ps -axo/.test(entry.command));
}
