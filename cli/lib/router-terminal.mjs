import { spawn } from "node:child_process";

/**
 * 打开一个终端窗口执行脚本（v1 形态，见实现计划 §6 R1）。
 *
 * 为什么不 detached 直接跑：TUI 需要 tty，没有终端就画不出来。
 * Windows 暂不支持下开窗口：返回 launched=false，由调用方回落为后台启动。
 */
export function openTerminal(options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const run = opts.spawn || spawn;
  const scriptPath = String(opts.scriptPath || "");
  if (!scriptPath) return { launched: false, kind: "none", reason: "缺少脚本路径" };

  let command = null;
  let args = [];
  if (platform === "darwin") {
    command = "open";
    args = ["-a", "Terminal", scriptPath];
  } else if (platform === "linux") {
    command = "x-terminal-emulator";
    args = ["-e", "sh", scriptPath];
  } else {
    return { launched: false, kind: "none", reason: "该平台暂不支持打开终端窗口，已回落为后台启动" };
  }

  try {
    const child = run(command, args, { detached: true, stdio: "ignore" });
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (child && typeof child.unref === "function") child.unref();
    return { launched: true, kind: platform, command };
  } catch (error) {
    return { launched: false, kind: "none", reason: error && error.message ? error.message : String(error) };
  }
}
