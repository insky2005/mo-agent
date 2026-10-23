import { spawn } from "node:child_process";

/**
 * 起一个执行者进程：shell 执行，prompt 从 stdin 进，输出直接透传。
 * 超时先 SIGTERM，3 秒后 SIGKILL。
 */
export function runExecutor({ command, cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;

    let child;
    try {
      child = spawn(command, {
        cwd,
        env,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ spawnError: error, code: null, signal: null, timedOut: false });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, timedOut });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    // 子进程输出走 stderr，stdout 留给 CLI 自己的结果（--json 时不能被污染）
    if (child.stdout) child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    child.on("error", (error) => finish({ spawnError: error, code: null, signal: null }));
    child.on("close", (code, signal) => finish({ spawnError: null, code, signal }));

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}
