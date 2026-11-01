import { spawn } from "node:child_process";

/**
 * 测通：真实发一条极短消息，确认模型与凭据可用。
 *
 * 首次引导里这一步不能省——最挫败的体验是"显示启动了，但 key 是错的"。
 * 关掉工具与会话落盘：只验证模型通道，不产生副作用。
 */
export function probeModel(options) {
  const opts = options || {};
  if (!opts.bin) return Promise.resolve({ ok: false, error: "没有可用的运行时" });
  const args = ["--print", String(opts.prompt || "ping"), "--no-tools", "--no-session"];
  if (opts.provider && opts.model) args.push("--provider", String(opts.provider), "--model", String(opts.model));
  const timeoutMs = Number(opts.timeoutMs) || 45000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawn(opts.bin, args, {
        env: { ...process.env, ...(opts.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, ms: 0, error: error.message || String(error) });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出
      }
      resolve({ ok: false, ms: Date.now() - startedAt, error: "超时（" + timeoutMs + "ms）" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, ms: Date.now() - startedAt, error: error.message || String(error) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = String(stdout || "").trim();
      const ok = code === 0 && text.length > 0;
      resolve({
        ok,
        ms: Date.now() - startedAt,
        code,
        text: text.slice(0, 200) || null,
        error: ok ? null : (String(stderr || "").trim().slice(-400) || "没有输出"),
      });
    });
  });
}
