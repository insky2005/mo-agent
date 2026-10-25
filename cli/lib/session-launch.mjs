import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MoError } from "../../core/errors.mjs";
import { ensureDir } from "./fsx.mjs";

/**
 * 会话型 worker 的启动器：把卡写成信封文件 + 生成一个 run 脚本，
 * 然后在 iTerm / Terminal.app 里开新窗口跑交互式 CLI —— 过程对人是可见的。
 *
 * MO_LAUNCHER=print 只打印，不真的开窗口（测试与无 GUI 环境用）。
 * MO_TERMINAL=iterm|terminal|none 强制指定终端。
 */

const ITERM = [
  "/Applications/iTerm.app",
  path.join(os.homedir(), "Applications/iTerm.app"),
];

export function detectTerminal(env = process.env) {
  const forced = String(env.MO_TERMINAL || "").toLowerCase();
  if (forced === "iterm" || forced === "terminal" || forced === "none") return forced;
  if (ITERM.some((candidate) => fs.existsSync(candidate))) return "iterm";
  if (process.platform === "darwin") return "terminal";
  return "none";
}

/** POSIX shell 单引号转义 */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function sessionPaths(root, taskId) {
  const base = path.join(root, ".mo-agent");
  return {
    envelope: path.join(base, "envelopes", taskId + ".md"),
    script: path.join(base, "runs", taskId + ".sh"),
  };
}

/** 脚本内容：cd 到项目、说明回执位置、起交互式 CLI */
export function renderRunScript({ root, taskId, title, command, prompt, receipt }) {
  return [
    "#!/bin/bash",
    "set -e",
    "cd " + shellQuote(root),
    "echo " + shellQuote("mo 任务 " + taskId + "：" + title),
    "echo " + shellQuote("回执写到：" + receipt),
    "echo",
    "exec " + command + " " + shellQuote(prompt),
    "",
  ].join("\n");
}

export function writeSessionAssets({ root, taskId, title, command, prompt, receipt, envelopeText }) {
  const files = sessionPaths(root, taskId);
  ensureDir(path.dirname(files.envelope));
  ensureDir(path.dirname(files.script));
  fs.writeFileSync(files.envelope, envelopeText, "utf8");
  fs.writeFileSync(files.script, renderRunScript({ root, taskId, title, command, prompt, receipt }), { mode: 0o755 });
  return files;
}

function appleScriptString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function applescript(kind, scriptPath) {
  const command = "bash " + shellQuote(scriptPath);
  if (kind === "iterm") {
    return [
      'tell application "iTerm"',
      "  activate",
      "  set newWindow to (create window with default profile)",
      "  tell current session of newWindow",
      "    write text " + appleScriptString(command),
      "  end tell",
      "end tell",
    ].join("\n");
  }
  return [
    'tell application "Terminal"',
    "  activate",
    "  do script " + appleScriptString(command),
    "end tell",
  ].join("\n");
}

/** @returns {{kind: string, launched: boolean}} */
export function launchTerminal({ kind, script, env = process.env }) {
  if (String(env.MO_LAUNCHER || "").toLowerCase() === "print") {
    return { kind: "print", launched: false };
  }
  if (kind === "none") {
    throw new MoError("E_NO_TERMINAL", "没有可用的终端，无法开启会话型 worker", {
      hint: "macOS 装 iTerm 或直接用 Terminal.app；服务器/CI 场景请用无头 worker 或改 --exec",
    });
  }
  const result = spawnSync("osascript", ["-e", applescript(kind, script)], { encoding: "utf8" });
  if (result.error) {
    throw new MoError("E_DISPATCH_FAILED", "打开终端失败：" + result.error.message);
  }
  if (result.status !== 0) {
    throw new MoError("E_DISPATCH_FAILED", "打开终端失败：" + String(result.stderr || "").trim());
  }
  return { kind, launched: true };
}
