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
 * 终端怎么开：
 *   MO_LAUNCH_CMD='<命令模板>'   自定义，{script} 会被替换成转义后的脚本路径
 *   MO_TERMINAL=iterm|terminal|none
 *   否则 macOS 探测 iTerm → Terminal.app
 *
 * MO_LAUNCHER=print 只打印，不真的开窗口（测试与无 GUI 环境用）。
 */

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

/** projectRoot 决定文件落哪；cwd 决定脚本 cd 到哪（卡上的 workdir） */
export function writeSessionAssets({ projectRoot, cwd, taskId, title, command, prompt, receipt, envelopeText }) {
  const files = sessionPaths(projectRoot, taskId);
  ensureDir(path.dirname(files.envelope));
  ensureDir(path.dirname(files.script));
  fs.writeFileSync(files.envelope, envelopeText, "utf8");
  fs.writeFileSync(files.script, renderRunScript({ root: cwd, taskId, title, command, prompt, receipt }), { mode: 0o755 });
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

/**
 * @param {{spec: {kind: string, name?: string, command?: string}, script: string}} input
 * @returns {{kind: string, launched: boolean}}
 */
export function launchTerminal({ spec, script }) {
  const kind = spec && spec.kind;
  if (kind === "print") return { kind: "print", launched: false };

  if (kind === "custom") {
    // {script} 是已转义的路径；{raw} 原样，方便自己拼
    const command = String(spec.command || "").split("{script}").join(shellQuote(script)).split("{raw}").join(script);
    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    if (result.error) {
      throw new MoError("E_DISPATCH_FAILED", "自定义终端执行失败：" + result.error.message);
    }
    if (result.status !== 0) {
      throw new MoError("E_DISPATCH_FAILED", "自定义终端退出码 " + result.status + "：" + String(result.stderr || "").trim());
    }
    return { kind: "custom", launched: true };
  }

  if (kind === "none") {
    throw new MoError("E_NO_TERMINAL", "没有可用的终端，无法开启会话型 worker", {
      hint: "mo terminal list 看可用终端，mo terminal use iterm 设默认；服务器/CI 请用无头 worker",
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
