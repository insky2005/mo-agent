import { spawn } from "node:child_process";

const TAIL_LIMIT = 4000;

/**
 * 起一个执行者进程：shell 执行，prompt 从 stdin 进。
 * 输出同时透传到 stderr（并保留末尾若干字节，失败时用来解释原因）。
 * 超时先 SIGTERM，3 秒后 SIGKILL。
 */
export function runExecutor({ command, cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    let tail = "";

    const collect = (chunk) => {
      tail += chunk.toString();
      if (tail.length > TAIL_LIMIT) tail = tail.slice(-TAIL_LIMIT);
    };

    let child;
    try {
      // 默认 /bin/sh：模板只依赖 POSIX 子集，sh 到处都有。
      // 需要 bash 特性（[[ ]]、数组、pipefail）时用 MO_SHELL=/bin/bash 覆盖。
      const shell = env.MO_SHELL || (process.platform === "win32" ? true : "/bin/sh");
      child = spawn(command, {
        cwd,
        env,
        shell,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ spawnError: error, code: null, signal: null, timedOut: false, outputTail: "" });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, timedOut, outputTail: tail.trim() });
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
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        collect(chunk);
        process.stderr.write(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        collect(chunk);
        process.stderr.write(chunk);
      });
    }

    child.on("error", (error) => finish({ spawnError: error, code: null, signal: null }));
    child.on("close", (code, signal) => finish({ spawnError: null, code, signal }));

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}