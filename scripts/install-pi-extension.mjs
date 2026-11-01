#!/usr/bin/env node
/**
 * 安装/卸载 Pi 控制扩展。
 *
 *   node scripts/install-pi-extension.mjs --status
 *   node scripts/install-pi-extension.mjs --install [--check]
 *   node scripts/install-pi-extension.mjs --uninstall
 *
 * 扩展写到 ~/.pi/agent/extensions/（或 PI_CODING_AGENT_DIR）。
 * --check 会真的启动一次 pi --mode rpc 并请求 get_state，确认扩展能加载。
 */
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  installPiExtension,
  piExtensionDir,
  piExtensionStatus,
  uninstallPiExtension,
} from "../host/pi-extension.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.MO_AGENT_ROOT ? path.resolve(process.env.MO_AGENT_ROOT) : path.resolve(here, "..");
const home = os.homedir();

function usage() {
  console.log([
    "用法: node scripts/install-pi-extension.mjs [选项]",
    "",
    "  --status       查看安装状态（默认）",
    "  --install      安装/更新扩展",
    "  --uninstall    卸载扩展",
    "  --check        安装后真实启动 pi，验证扩展能加载",
    "  --dry-run      只预览，不写盘",
    "  --json         机器可读输出",
    "  -h, --help     显示帮助",
  ].join("\n"));
}

const args = process.argv.slice(2);
let action = "status";
let dryRun = false;
let asJson = false;
let check = false;
for (const arg of args) {
  if (arg === "--install") action = "install";
  else if (arg === "--uninstall") action = "uninstall";
  else if (arg === "--status") action = "status";
  else if (arg === "--check") check = true;
  else if (arg === "--dry-run") dryRun = true;
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

function print(value) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value.action === "status") {
    console.log("Pi 控制扩展目录: " + value.dir);
    for (const file of value.files) {
      console.log("  " + file.name + "：" + (file.exists ? (file.marker ? "已安装" : "存在但不是 mo-agent 的") : "未安装") + (file.outdated ? "（待更新）" : ""));
    }
    console.log(value.installed ? (value.outdated ? "状态：需要更新" : "状态：已安装") : "状态：未安装");
    return;
  }
  if (!value.ok) {
    console.log("✗ " + (value.error || "操作失败"));
    return;
  }
  if (value.action === "install") {
    console.log(value.changed ? (dryRun ? "将安装到 " : "已安装到 ") + value.dir : "已是最新，无需改动");
    for (const file of value.files) console.log("  " + file.name + "：" + file.action + (file.backup ? "（备份 " + file.backup + "）" : ""));
  } else if (value.action === "uninstall") {
    console.log(value.changed ? "已从 " + value.dir + " 卸载" : "没有需要卸载的文件");
    for (const file of value.files) console.log("  " + file.name + "：" + file.action + (file.reason ? "（" + file.reason + "）" : ""));
  }
}

function healthCheck() {
  return new Promise((resolve) => {
    const loader = path.join(piExtensionDir({ home }), "mo-agent-control.js");
    let child;
    try {
      child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", loader], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: "启动 pi 失败: " + error.message });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (error) { /* 忽略 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "超时：pi 没有响应 get_state" }), 8000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      if (out.includes('"command":"get_state"') && out.includes('"success":true')) {
        clearTimeout(timer);
        finish({ ok: true });
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: "启动 pi 失败: " + error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) finish({ ok: false, error: "pi 退出（code " + code + "）" + (err ? ": " + err.trim().split("\n").slice(-2).join(" | ") : "") });
    });
    try {
      child.stdin.write(JSON.stringify({ id: "mo-health", type: "get_state" }) + "\n");
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, error: "写入 get_state 失败: " + error.message });
    }
  });
}

if (action === "status") {
  print(Object.assign({ action: "status" }, piExtensionStatus({ root, home })));
  process.exit(0);
}

if (action === "uninstall") {
  const result = uninstallPiExtension({ root, home, dryRun });
  print(Object.assign({ action: "uninstall" }, result));
  process.exit(result.ok ? 0 : 1);
}

const result = installPiExtension({ root, home, dryRun, now: Date.now() });
print(Object.assign({ action: "install" }, result));
if (!result.ok) process.exit(1);

if (check && !dryRun) {
  const health = await healthCheck();
  if (asJson) console.log(JSON.stringify({ action: "check", ...health }, null, 2));
  else console.log(health.ok ? "✓ 健康检查通过：pi 能加载控制扩展" : "⚠ 健康检查失败：" + health.error + "\n  可运行 npm run pi:uninstall 回滚");
  if (!health.ok) process.exitCode = 1;
}
