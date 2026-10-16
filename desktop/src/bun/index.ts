import { Tray, BrowserWindow, Utils } from "electrobun/main";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, readdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// 只驻留菜单栏，不占 Dock
try {
  Utils.setDockIconVisible(false);
} catch (error) {
  // 非 macOS 平台或 API 不可用时忽略
}

const PORT = Number(process.env.MO_AGENT_PORT || 7788);
const BASE = "http://127.0.0.1:" + PORT;
const PANEL_URL = BASE + "/setup";
const REPO_ROOT = process.env.MO_AGENT_ROOT || "/Users/dev/c/work.ai/deepseek-harness/mo-agent";
const HOST_ENTRY = REPO_ROOT + "/host/index.mjs";

const LOG_DIR = join(homedir(), "Library", "Logs", "mo-agent");
const LOG_FILE = join(LOG_DIR, "host.log");

let host: ChildProcess | null = null;
let panel: BrowserWindow | null = null;
let logs: BrowserWindow | null = null;

/**
 * 自己找 node，不能靠 PATH：双击启动时 macOS 只给
 * /usr/bin:/bin:/usr/sbin:/sbin，既没有 nvm 也没有 homebrew，
 * 直接 spawn("node") 会 ENOENT —— 表现为「托盘在，但面板和浏览器都打不开」。
 */
function resolveNode(): string {
  const candidates: string[] = [];
  const override = process.env.MO_AGENT_NODE;
  if (override) candidates.push(override);
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");

  const home = homedir();
  const versionDirs: Array<[string, string]> = [
    [join(home, ".nvm", "versions", "node"), "bin/node"],
    [join(home, ".local", "share", "fnm", "node-versions"), "installation/bin/node"],
    [join(home, ".volta", "bin"), "node"],
  ];
  for (const [dir, suffix] of versionDirs) {
    try {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir).sort().reverse()) {
        candidates.push(join(dir, entry, suffix));
      }
    } catch (error) {
      /* 忽略 */
    }
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch (error) {
      /* 忽略 */
    }
  }
  return "node";
}

function openLog(): WriteStream | null {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    return createWriteStream(LOG_FILE, { flags: "a" });
  } catch (error) {
    return null;
  }
}

function logLine(text: string): void {
  const stream = openLog();
  if (!stream) return;
  stream.write("[" + new Date().toISOString() + "] " + text + "\n");
  stream.end();
}

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE + "/api/health");
    return res.ok;
  } catch (error) {
    return false;
  }
}

async function ensureHost(): Promise<boolean> {
  if (await isUp()) return true;

  if (!host) {
    const nodeBin = resolveNode();
    const stream = openLog();
    try {
      if (stream) {
        stream.write("\n==== " + new Date().toISOString() + " 启动 host ====\n");
        stream.write("node: " + nodeBin + "\nhost: " + HOST_ENTRY + "\n");
      }
      host = spawn(nodeBin, [HOST_ENTRY, "--port", String(PORT)], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MO_AGENT_LOG_FILE: LOG_FILE,
          PATH: (process.env.PATH || "") + ":/opt/homebrew/bin:/usr/local/bin",
        },
        stdio: stream ? ["ignore", stream, stream] : "inherit",
      });
      host.on("error", (error: Error) => {
        logLine("spawn 失败: " + error.message + "（node 路径: " + nodeBin + "）");
        host = null;
      });
      host.on("exit", (code: number | null) => {
        logLine("host 退出，code=" + code);
        host = null;
      });
    } catch (error) {
      logLine("启动服务异常: " + error);
      return false;
    }
  }

  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await isUp()) return true;
  }
  logLine("启动超时：60 次探测都没等到 /api/health");
  return false;
}

function disposePanel(): void {
  if (!panel) return;
  const current = panel;
  panel = null;
  try { current.close(); } catch (error) { /* 已经销毁 */ }
}

function createPanel(): void {
  const win = new BrowserWindow({
    title: "mo-agent · 设置（安装与配对）",
    url: PANEL_URL,
    frame: { width: 760, height: 760 },
  });
  panel = win;
  try {
    win.on("close", () => { if (panel === win) panel = null; });
  } catch (error) {
    logLine("注册窗口关闭事件失败: " + error);
  }
}

async function openPanel(): Promise<void> {
  const ready = await ensureHost();
  if (!ready) {
    logLine("本地服务启动失败，详见 " + LOG_FILE);
    Utils.openExternal("file://" + LOG_DIR);
    return;
  }
  if (panel) {
    try {
      panel.show();
      panel.activate();
      return;
    } catch (error) {
      panel = null;
    }
  }
  createPanel();
}

function createLogsWindow(): void {
  const win = new BrowserWindow({
    title: "mo-agent · 日志",
    url: BASE + "/logs",
    frame: { width: 900, height: 640 },
  });
  logs = win;
  try {
    win.on("close", () => { if (logs === win) logs = null; });
  } catch (error) {
    logLine("注册日志窗口关闭事件失败: " + error);
  }
}

/** 日志也走面板窗口：加载 host 的 /logs 页面，可实时刷新。 */
async function openLogs(): Promise<void> {
  const ready = await ensureHost();
  if (!ready) {
    // 服务没起来时日志页打不开，退回系统默认程序
    try {
      if (existsSync(LOG_FILE)) Utils.openPath(LOG_FILE);
      else Utils.openExternal("file://" + LOG_DIR);
    } catch (error) {
      logLine("打开日志失败: " + error);
    }
    return;
  }
  if (logs) {
    try {
      logs.show();
      logs.activate();
      return;
    } catch (error) {
      logs = null;
    }
  }
  createLogsWindow();
}

async function restartHost(): Promise<void> {
  disposePanel();
  if (logs) {
    const current = logs;
    logs = null;
    try { current.close(); } catch (error) { /* 已经销毁 */ }
  }
  if (host) {
    host.kill();
    host = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await ensureHost();
  // 重启后总是重新打开「设置（安装与配对）」
  await openPanel();
}

const tray = new Tray({ image: "views://mainview/tray.png", template: true, width: 18, height: 18 });

tray.setMenu([
  { type: "normal", label: "设置（安装与配对）", action: "panel" },
  { type: "divider" },
  { type: "normal", label: "重启服务", action: "restart" },
  { type: "normal", label: "查看日志", action: "logs" },
  { type: "divider" },
  { type: "normal", label: "退出", action: "quit" },
]);

tray.on("tray-clicked", async (event: any) => {
  const action = event?.data?.action;
  if (action === "panel") await openPanel();
  else if (action === "restart") await restartHost();
  else if (action === "logs") await openLogs();
  else if (action === "quit") {
    if (host) host.kill();
    tray.remove();
    process.exit(0);
  }
});

ensureHost().then((ready) => {
  logLine(ready ? "服务已就绪: " + PANEL_URL : "服务启动失败（node 解析为 " + resolveNode() + "）");
  // 启动后默认打开「设置（安装与配对）」面板
  if (ready) openPanel();
}).catch((error) => logLine("启动流程异常: " + error));

