#!/usr/bin/env node
/**
 * 在终端管理各 Agent 的 mo-agent hook 配置。
 *
 *   node scripts/configure-hooks.mjs                 查看状态
 *   node scripts/configure-hooks.mjs --all           一键配置所有支持的 Agent
 *   node scripts/configure-hooks.mjs --agent claude-code
 *   node scripts/configure-hooks.mjs --agent qoder-cn
 *   node scripts/configure-hooks.mjs --all --uninstall
 *   node scripts/configure-hooks.mjs --all --dry-run 只预览，不写盘
 *
 * 和设置页 /agents 走同一套 host/agent-hooks.mjs，行为完全一致。
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles } from "../adapters/registry.mjs";
import { createHooksManager } from "../host/agent-hooks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.MO_AGENT_ROOT ? path.resolve(process.env.MO_AGENT_ROOT) : path.resolve(here, "..");

function usage() {
  console.log([
    "用法: node scripts/configure-hooks.mjs [选项]",
    "",
    "  --all                 所有支持一键配置的 Agent（默认）",
    "  --agent <id>          只处理一个 Agent，例如 claude-code",
    "  --install             安装/更新 hook 配置（给 --all / --agent 时默认）",
    "  --uninstall           移除 mo-agent 写入的 hook 配置",
    "  --dry-run             只打印将要发生的变化，不写盘",
    "  --json                机器可读输出",
    "  -h, --help            显示帮助",
  ].join("\n"));
}

const args = process.argv.slice(2);
let action = "status";
let actionExplicit = false;
let agentId = "all";
let dryRun = false;
let asJson = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  // 只要给了 --all / --agent / --dry-run，默认就是安装；--uninstall 显式优先
  const defaultInstall = () => { if (!actionExplicit) action = "install"; };
  if (arg === "--install" || arg === "--apply") { action = "install"; actionExplicit = true; }
  else if (arg === "--uninstall") { action = "uninstall"; actionExplicit = true; }
  else if (arg === "--all") { agentId = "all"; defaultInstall(); }
  else if (arg === "--agent") {
    agentId = args[++i] || "";
    if (!agentId) {
      console.error("--agent 后面需要 Agent id");
      process.exit(2);
    }
    defaultInstall();
  } else if (arg === "--dry-run") { dryRun = true; defaultInstall(); }
  else if (arg === "--json") asJson = true;
  else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    console.error("未知参数: " + arg);
    usage();
    process.exit(2);
  }
}

const profiles = loadProfiles(path.join(root, "adapters", "profiles"));
const manager = createHooksManager({
  root,
  profiles,
  home: os.homedir(),
  log: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
});

function stateOf(item) {
  if (!item.supported) return item.reason || "暂不支持";
  if (item.error) return "配置读取失败";
  if (item.installed && item.outdated) return "需要更新";
  if (item.installed) return "已配置";
  if (item.events.some((event) => event.installed)) return "部分配置";
  return "未配置";
}

if (action === "status") {
  if (asJson) {
    console.log(JSON.stringify(manager.status(), null, 2));
    process.exit(0);
  }
  console.log("Agent hook 配置（root: " + root + "）\n");
  for (const item of manager.status()) {
    const parts = [];
    parts.push(item.label + " (" + item.id + ")");
    parts.push("  " + stateOf(item));
    const settingsPaths = Array.isArray(item.settingsPaths) && item.settingsPaths.length
      ? item.settingsPaths
      : (item.settingsPath ? [item.settingsPath] : []);
    if (settingsPaths.length) parts.push("  配置: " + settingsPaths.join("、") + (item.exists ? "" : "（将创建）"));
    if (item.events.length) {
      parts.push("  事件: " + item.events.map((event) => event.event
        + (event.installed ? (event.outdated ? "（路径待更新）" : "（已配置）") : "（未配置）")).join(", "));
    }
    if (item.error) parts.push("  错误: " + item.error);
    if (item.runnerMissing) parts.push("  警告: 找不到 hook 入口 " + item.cliPath + "，请重新构建/安装 mo-agent");
    console.log(parts.join("\n"));
    console.log("");
  }
  console.log("一键配置: node scripts/configure-hooks.mjs --all");
  console.log("移除配置: node scripts/configure-hooks.mjs --all --uninstall");
  process.exit(0);
}

const results = manager.apply({ agentId, action, dryRun });
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
  if (results.some((item) => !item.ok)) process.exitCode = 1;
} else {
  for (const item of results) {
    const name = item.label || item.id;
    if (!item.ok) {
      console.log("✗ " + name + "：" + item.error);
      continue;
    }
    if (item.dryRun) {
      console.log("· " + name + "：将" + (action === "uninstall" ? "移除" : "写入") + " " + item.events.join(", ") + "（dry-run，未写盘）");
    } else if (!item.changed) {
      console.log("✓ " + name + "：" + (item.message || "已是最新配置"));
    } else {
      console.log("✓ " + name + "：" + (action === "uninstall" ? "已移除" : "已写入") + " " + item.events.join(", "));
      if (item.settingsPath) console.log("  文件: " + item.settingsPath);
      if (item.backupPath) console.log("  备份: " + item.backupPath);
    }
  }
  if (!results.some((item) => item.ok)) process.exitCode = 1;
}
