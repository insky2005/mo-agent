import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { readJsonSafe, writeJsonAtomic } from "./fsx.mjs";

/**
 * 终端（会话型 worker 的启动方式）。
 *
 * 内置：iterm / terminal / print / none
 * 自定义：`mo terminal add <名> --command '<模板>'`，模板里用 {script} 或 {raw}
 *
 * 解析优先级：MO_LAUNCHER=print > MO_LAUNCH_CMD > MO_TERMINAL > 默认 > 自动探测
 */

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const BUILTIN_TERMINALS = {
  iterm: { kind: "iterm", description: "iTerm2（macOS）" },
  terminal: { kind: "terminal", description: "Terminal.app（macOS）" },
  print: { kind: "print", description: "只生成脚本，不开窗口（排查用）" },
  none: { kind: "none", description: "不启动；派单会报 E_NO_TERMINAL" },
};

const ITERM_APP = [
  "/Applications/iTerm.app",
  path.join(os.homedir(), "Applications/iTerm.app"),
];

export function terminalsFile(home) {
  return path.join(home, "terminals.json");
}

function readConfig(home) {
  const value = readJsonSafe(terminalsFile(home), null);
  const terminals = value && typeof value === "object" && value.terminals && typeof value.terminals === "object" ? value.terminals : {};
  const fallback = value && typeof value === "object" && typeof value.default === "string" ? value.default : "";
  return { default: fallback, terminals };
}

function writeConfig(home, config) {
  writeJsonAtomic(terminalsFile(home), { version: 1, default: config.default || "", terminals: config.terminals });
}

export function terminalByName({ home, name }) {
  const key = String(name || "").trim();
  if (BUILTIN_TERMINALS[key]) return { name: key, source: "builtin", ...BUILTIN_TERMINALS[key] };
  const config = readConfig(home);
  const custom = config.terminals[key];
  if (custom) return { name: key, source: "custom", kind: "custom", command: custom.command, description: custom.description || "" };
  return null;
}

export function listTerminals({ home }) {
  const config = readConfig(home);
  const builtin = Object.entries(BUILTIN_TERMINALS).map(([name, item]) => ({
    name,
    source: "builtin",
    default: config.default === name,
    ...item,
  }));
  const custom = Object.entries(config.terminals).map(([name, item]) => ({
    name,
    source: "custom",
    kind: "custom",
    default: config.default === name,
    command: item.command,
    description: item.description || "",
  }));
  return [...builtin, ...custom];
}

export function addTerminal({ home, name, command, description = "" }) {
  const key = String(name || "").trim();
  if (!NAME_RE.test(key)) {
    throw new MoError("E_USAGE", "名称不合法：" + key, { hint: "小写字母、数字、连字符，例如 my-tmux" });
  }
  if (BUILTIN_TERMINALS[key]) throw new MoError("E_USAGE", key + " 与内置终端同名，换一个名称");
  const template = String(command || "").trim();
  if (!template) throw new MoError("E_USAGE", "缺少 --command");
  if (!template.includes("{script}") && !template.includes("{raw}")) {
    throw new MoError("E_USAGE", "命令模板必须包含 {script} 或 {raw}", {
      hint: "例：tmux new-window \"bash {script}\"",
    });
  }

  const config = readConfig(home);
  config.terminals[key] = { command: template, description: String(description || "").trim() };
  writeConfig(home, config);
  return { name: key, file: terminalsFile(home), ...config.terminals[key] };
}

export function removeTerminal({ home, name }) {
  const key = String(name || "").trim();
  if (BUILTIN_TERMINALS[key]) throw new MoError("E_USAGE", key + " 是内置终端，不能删除");
  const config = readConfig(home);
  if (!config.terminals[key]) throw new MoError("E_NOT_FOUND", "没有这个终端：" + key);
  delete config.terminals[key];
  if (config.default === key) config.default = "";
  writeConfig(home, config);
  return { name: key };
}

export function setDefaultTerminal({ home, name }) {
  const key = String(name || "").trim();
  const found = terminalByName({ home, name: key });
  if (!found) {
    throw new MoError("E_NOT_FOUND", "没有这个终端：" + key, { hint: "mo terminal list 查看可用终端" });
  }
  if (found.kind === "none") {
    throw new MoError("E_USAGE", "none 不能设为默认（派单会直接失败）", { hint: "临时禁用请设 AMBIENT 无效……用 MO_TERMINAL=none" });
  }
  const config = readConfig(home);
  config.default = key;
  writeConfig(home, config);
  return { name: key, kind: found.kind };
}

export function currentTerminal({ home }) {
  const config = readConfig(home);
  return config.default || "";
}

/** 探测本机有哪些图形终端；给 mo terminal current 与 mo setup 用 */
export function detectTerminal() {
  if (ITERM_APP.some((candidate) => fs.existsSync(candidate))) return "iterm";
  if (process.platform === "darwin") return "terminal";
  return "none";
}

/**
 * 决定这次派单用哪个终端。
 * @returns {{name: string, kind: string, command?: string, reason: string}}
 */
export function resolveTerminal({ home, env = process.env }) {
  const picked = (() => {
    const envCommand = String(env.MO_LAUNCH_CMD || "").trim();
    if (envCommand) {
      return { name: "custom", kind: "custom", command: envCommand, reason: "env:MO_LAUNCH_CMD" };
    }
    const forced = String(env.MO_TERMINAL || "").trim();
    if (forced) {
      const found = terminalByName({ home, name: forced });
      if (!found) {
        throw new MoError("E_USAGE", "MO_TERMINAL 指向未知终端：" + forced, {
          hint: "可用：" + listTerminals({ home }).map((item) => item.name).join(" / "),
        });
      }
      return { ...found, reason: "env:MO_TERMINAL" };
    }
    const config = readConfig(home);
    if (config.default) {
      const found = terminalByName({ home, name: config.default });
      if (found) return { ...found, reason: "default" };
    }
    const detected = detectTerminal();
    return { ...terminalByName({ home, name: detected }), reason: "auto" };
  })();

  // print 只是"不真的开窗口"，仍然保留本来会用的终端名，账本才能看出意图
  if (String(env.MO_LAUNCHER || "").toLowerCase() === "print") {
    return { ...picked, kind: "print", reason: "env:MO_LAUNCHER", dryRun: true, plannedKind: picked.kind };
  }
  return picked;
}