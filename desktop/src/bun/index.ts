import { Tray, BrowserWindow, Utils, Screen, GlobalShortcut } from "electrobun/main";
import { dlopen, FFIType } from "bun:ffi";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, statSync, readdirSync, readFileSync, writeFileSync, rmSync, renameSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
// 开发态：显式 MO_AGENT_ROOT 直接用源码；否则使用打包进 .app 的 runtime。
const DEV_ROOT = process.env.MO_AGENT_ROOT || "";
const FALLBACK_REPO_ROOT = "/Users/dev/c/work.ai/deepseek-harness/mo-agent";
const SHELL_DIR = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(homedir(), "Library", "Application Support", "mo-agent", "runtime");
const RUNTIME_VERSION_FILE = "runtime.json";

const LOG_DIR = join(homedir(), "Library", "Logs", "mo-agent");
const LOG_FILE = join(LOG_DIR, "host.log");
// 桌面壳只写自己的 desktop.log；host.log 由 host 自己写并在 5MB 处轮转。
const DESKTOP_LOG_FILE = join(LOG_DIR, "desktop.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
// 与 host 共用同一份开关；勾选后重启服务生效。
const VOICE_CONFIG = join(homedir(), ".mo-agent", "voice.json");

function readVoiceEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(VOICE_CONFIG, "utf8"));
    return Boolean(parsed && parsed.enabled === true);
  } catch (error) {
    return false;
  }
}

function writeVoiceEnabled(enabled: boolean): void {
  try {
    mkdirSync(dirname(VOICE_CONFIG), { recursive: true });
    writeFileSync(VOICE_CONFIG, JSON.stringify({ enabled }, null, 2) + "\n");
  } catch (error) {
    logLine("写入语音配置失败: " + error);
  }
}

let host: ChildProcess | null = null;
let panel: BrowserWindow | null = null;
let logs: BrowserWindow | null = null;
const VOICE_OVERLAY_STATE = join(homedir(), ".mo-agent", "voice-overlay.json");
const VOICE_OVERLAY_WIDTH = 392;
// 常驻浮层同时显示草稿区与三个操作按钮，比 P1 的命令浮层高一档。
const VOICE_OVERLAY_HEIGHT = 400;

function readVoiceOverlayFrame(): { x: number; y: number; width: number; height: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(VOICE_OVERLAY_STATE, "utf8"));
    const frame = {
      x: Number(parsed.x),
      y: Number(parsed.y),
      width: Number(parsed.width) || VOICE_OVERLAY_WIDTH,
      height: Number(parsed.height) || VOICE_OVERLAY_HEIGHT,
    };
    if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)) return null;
    // 显示器换了或位置明显不合理时回到居中。
    if (frame.x < -5000 || frame.x > 8000 || frame.y < -2000 || frame.y > 6000) return null;
    return frame;
  } catch (error) {
    return null;
  }
}

function saveVoiceOverlayFrame(frame: { x: number; y: number; width: number; height: number }): void {
  if (!frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y)) return;
  if (!(frame.width >= 100) || !(frame.height >= 100)) return;
  try {
    mkdirSync(dirname(VOICE_OVERLAY_STATE), { recursive: true });
    writeFileSync(VOICE_OVERLAY_STATE, JSON.stringify(frame, null, 2) + "\n");
  } catch (error) {
    logLine("保存语音浮层位置失败: " + error);
  }
}

let voiceOverlay: BrowserWindow | null = null;
let voiceOverlayToken = "";
let voiceOverlayFrame = readVoiceOverlayFrame();
let voiceOverlayVisible = false;
let voiceOverlayCursorInside = false;
let voiceOrb: BrowserWindow | null = null;
let voiceOrbVisible = false;
let voiceOrbCursorInside = false;
let voiceOrbPending = false;
let voiceOrbDragged = false;
let voiceOrbDragPos: { x: number; y: number } | null = null;
let voiceOrbDragLastCursor: { x: number; y: number } | null = null;
let voiceOrbDragTimer: ReturnType<typeof setInterval> | null = null;
let voiceOrbDragSafety: ReturnType<typeof setTimeout> | null = null;
const VOICE_ORB_SIZE = 88;
let voiceOverlaySnapTimer: ReturnType<typeof setTimeout> | null = null;
let voiceOverlaySnapAnimationTimer: ReturnType<typeof setTimeout> | null = null;
let voiceOverlaySnapAnimating = false;
// 拖动停下后吸附到屏幕可视区域边缘；留一点距离，避免吸得太“黏”。
const VOICE_OVERLAY_SNAP_MARGIN = 18;
const VOICE_OVERLAY_SNAP_DELAY_MS = 140;
const VOICE_OVERLAY_SHORTCUT = process.env.MO_AGENT_VOICE_OVERLAY_SHORTCUT || "CommandOrControl+Shift+Space";
// Electrobun 的原生回调会把 accelerator 转成小写，注册表的 key 必须同样小写，否则回调找不到 handler。
const VOICE_OVERLAY_SHORTCUT_KEY = VOICE_OVERLAY_SHORTCUT.toLowerCase();
let voiceOverlayShortcutRegistered = false;
let lastOverlayShortcutAt = 0;
let accessibilityChecked = false;
let accessibilityTrusted: boolean | null = null;

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

function rotateLog(file: string): void {
  try { rmSync(file + "." + LOG_KEEP, { force: true }); } catch (error) { /* 忽略 */ }
  for (let index = LOG_KEEP - 1; index >= 1; index -= 1) {
    try { renameSync(file + "." + index, file + "." + (index + 1)); } catch (error) { /* 中间几份可能还没生成 */ }
  }
  try { renameSync(file, file + ".1"); } catch (error) { /* 首次写还没有当前文件 */ }
}

/** 桌面壳自己的日志：与 host.log 分开写，5MB 轮转，最多保留 3 份。 */
/** macOS 的全局按键监听需要辅助功能权限；没有权限时只在前台生效。 */
function checkAccessibilityTrust(): boolean | null {
  if (accessibilityChecked) return accessibilityTrusted;
  accessibilityChecked = true;
  try {
    const lib = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", {
      AXIsProcessTrusted: { args: [], returns: FFIType.bool },
    });
    accessibilityTrusted = Boolean(lib.symbols.AXIsProcessTrusted());
  } catch (error) {
    logLine("检查辅助功能权限失败: " + error);
    accessibilityTrusted = null;
  }
  return accessibilityTrusted;
}

function logLine(text: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const line = "[" + new Date().toISOString() + "] " + text + "\n";
    let size = 0;
    try { size = statSync(DESKTOP_LOG_FILE).size; } catch (error) { /* 还没写过 */ }
    if (size > 0 && size + Buffer.byteLength(line) > LOG_MAX_BYTES) rotateLog(DESKTOP_LOG_FILE);
    appendFileSync(DESKTOP_LOG_FILE, line);
  } catch (error) {
    /* 日志写失败不能影响托盘 */
  }
}

/** .app 内打包的 runtime.tar.gz。 */
function runtimePayloadTar(): string | null {
  const candidates = [
    // build.copy 的落点：Contents/Resources/app/runtime.tar.gz
    join(SHELL_DIR, "..", "runtime.tar.gz"),
    join(dirname(process.execPath), "..", "Resources", "app", "runtime.tar.gz"),
    join(process.cwd(), "app", "runtime.tar.gz"),
    join(process.cwd(), "runtime.tar.gz"),
  ];
  for (const file of candidates) {
    try {
      if (existsSync(file)) return file;
    } catch (error) {
      /* 忽略 */
    }
  }
  return null;
}

function readRuntimeVersion(dir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, RUNTIME_VERSION_FILE), "utf8"));
    return String(parsed.version || "");
  } catch (error) {
    return "";
  }
}

/**
 * 把 .app 里的 runtime 安装/更新到固定目录（版本不同才覆盖）。
 * 用户数据在 ~/.mo-agent，与这里隔离，升级不会丢配置。
 */
function ensureRuntime(): string {
  if (DEV_ROOT) return DEV_ROOT;

  const payload = runtimePayloadTar();
  if (!payload) {
    logLine("未找到打包 runtime，回退到开发仓库路径");
    return FALLBACK_REPO_ROOT;
  }

  const staging = RUNTIME_DIR + ".new";
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const result = spawnSync("tar", ["-xzf", payload, "-C", staging], { stdio: "ignore" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("tar 解包失败，status=" + result.status);

    const payloadVersion = readRuntimeVersion(staging);
    const installedVersion = readRuntimeVersion(RUNTIME_DIR);
    if (payloadVersion && payloadVersion === installedVersion) {
      rmSync(staging, { recursive: true, force: true });
      return RUNTIME_DIR;
    }

    if (host) {
      try { host.kill(); } catch (error) { /* 忽略 */ }
      host = null;
    }

    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    mkdirSync(dirname(RUNTIME_DIR), { recursive: true });
    renameSync(staging, RUNTIME_DIR);
    try { chmodSync(join(RUNTIME_DIR, "bin", "mo-agent-host"), 0o755); } catch (error) { /* 忽略 */ }
    logLine("运行时已安装/更新: " + (payloadVersion || "unknown") + " -> " + RUNTIME_DIR);
    return RUNTIME_DIR;
  } catch (error) {
    logLine("安装运行时失败，回退到开发仓库路径: " + error);
    try { rmSync(staging, { recursive: true, force: true }); } catch (cleanupError) { /* 忽略 */ }
    return existsSync(RUNTIME_DIR) ? RUNTIME_DIR : FALLBACK_REPO_ROOT;
  }
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

  const root = ensureRuntime();

  if (!host) {
    const packaged = !DEV_ROOT && existsSync(join(root, "bin", "mo-agent-host"));
    const command = packaged ? join(root, "bin", "mo-agent-host") : resolveNode();
    const args = packaged
      ? ["--port", String(PORT)]
      : [join(root, "host", "index.mjs"), "--port", String(PORT)];
    try {
      logLine("启动 host: " + command + " " + args.join(" ") + "（root: " + root + "）");
      host = spawn(command, args, {
        cwd: root,
        env: {
          ...process.env,
          MO_AGENT_ROOT: root,
          MO_AGENT_LOG_FILE: LOG_FILE,
          PATH: (process.env.PATH || "") + ":/opt/homebrew/bin:/usr/local/bin",
        },
        // host 自己写 host.log；这里不再重定向，避免两个进程抢同一个日志文件。
        stdio: ["ignore", "ignore", "ignore"],
      });
      host.on("error", (error: Error) => {
        logLine("spawn 失败: " + error.message + "（command: " + command + "）");
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
    win.on("close", () => {
      if (panel !== win) return;
      panel = null;
      // 设置窗口关闭后才显示常驻浮层，避免两个窗口同时挡住桌面。
      syncVoiceOverlay();
    });
  } catch (error) {
    logLine("注册窗口关闭事件失败: " + error);
  }
}

async function openPanel(): Promise<void> {
  const ready = await ensureHost();
  if (!ready) {
    logLine("本地服务启动失败，详见 " + LOG_DIR);
    Utils.openExternal("file://" + LOG_DIR);
    return;
  }
  // 先收起浮层与浮层球，把设置窗口放在前面；设置窗口关闭后由 close 事件恢复浮层。
  hideVoiceOverlay(false);
  hideVoiceOrb();
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

async function restartService(openPanelAfter: boolean): Promise<void> {
  disposePanel();
  if (voiceOverlay) {
    const current = voiceOverlay;
    try {
      voiceOverlayFrame = current.getFrame();
      saveVoiceOverlayFrame(voiceOverlayFrame);
    } catch (error) { /* 忽略 */ }
    voiceOverlay = null;
    voiceOverlayToken = "";
    try { current.close(); } catch (error) { /* 已经销毁 */ }
  }
  if (voiceOrb) {
    const current = voiceOrb;
    stopVoiceOrbDrag();
    voiceOrb = null;
    try { current.close(); } catch (error) { /* 已经销毁 */ }
  }
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
  if (openPanelAfter) await openPanel();
  // 语音开启时浮层常驻：服务重启后自动恢复，不再等下一次命令才出现。
  await syncVoiceOverlay();
  syncVoiceOrb();
}

async function restartHost(): Promise<void> {
  return restartService(true);
}

function trayMenu(): any[] {
  const voice = readVoiceEnabled();
  const voiceMenu: any[] = [
    { type: "normal", label: "启用语音", action: "voice", checked: voice },
    { type: "normal", label: "麦克风权限设置…", action: "mic-settings" },
    { type: "normal", label: "辅助功能权限设置…", action: "accessibility-settings" },
    { type: "divider" },
    { type: "normal", label: "语音命令", action: "voice-command" },
    { type: "normal", label: "语音口述任务", action: "dictate" },
    { type: "normal", label: "语音测试", action: "voice-test" },
  ];
  return [
    { type: "normal", label: "设置（安装与配对）", action: "panel" },
    {
      type: "normal",
      label: (voiceOverlayVisible ? "隐藏语音浮层" : "显示语音浮层")
        + "（" + voiceOverlayShortcutLabel() + "）",
      action: "toggle-overlay",
      // 设置窗口打开时浮层固定收起，等设置窗口关闭后再显示。
      enabled: voice && !panel,
    },
    { type: "normal", label: "语音", submenu: voiceMenu },
    { type: "divider" },
    { type: "normal", label: "重启服务", action: "restart" },
    { type: "normal", label: "查看日志", action: "logs" },
    { type: "divider" },
    { type: "normal", label: "退出", action: "quit" },
  ];
}

function refreshTrayMenu(): void {
  try {
    tray.setMenu(trayMenu());
  } catch (error) {
    logLine("更新托盘菜单失败: " + error);
  }
}

async function toggleVoice(): Promise<void> {
  const enabled = !readVoiceEnabled();
  writeVoiceEnabled(enabled);
  refreshTrayMenu();
  syncVoiceOverlayShortcut();
  logLine("启用语音: " + (enabled ? "开启" : "关闭"));
  await restartService(false);
}

function openMicSettings(): void {
  try {
    Utils.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  } catch (error) {
    logLine("打开麦克风设置失败: " + error);
  }
}

function openAccessibilitySettings(): void {
  try {
    Utils.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  } catch (error) {
    logLine("打开辅助功能设置失败: " + error);
  }
}

function readLocalToken(): string {
  let token = process.env.MO_AGENT_LOCAL_TOKEN || "";
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), ".mo-agent", "session.json"), "utf8"));
    token = parsed.token || token;
  } catch (error) {
    /* 没有就用环境变量 */
  }
  return token;
}

async function postLocal(pathname: string, timeoutMs: number): Promise<any> {
  const token = readLocalToken();
  if (!token) throw new Error("找不到本机令牌，先重启一次服务");
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(BASE + pathname, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mo-agent-local": token },
      body: "{}",
      signal: controller.signal,
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function hideVoiceOverlay(showOrb: boolean = true): void {
  cancelVoiceOverlaySnap();
  if (!voiceOverlay) {
    if (showOrb) void showVoiceOrb().catch((error) => logLine("显示语音浮层球失败: " + error));
    return;
  }
  try {
    voiceOverlayFrame = voiceOverlay.getFrame();
    saveVoiceOverlayFrame(voiceOverlayFrame);
  } catch (error) { /* 忽略 */ }
  try { voiceOverlay.hide(); } catch (error) { /* 已关闭 */ }
  voiceOverlayVisible = false;
  voiceOverlayCursorInside = false;
  refreshTrayMenu();
  if (showOrb) void showVoiceOrb().catch((error) => logLine("显示语音浮层球失败: " + error));
}

/** Logo 与浮层窗口的右上角对齐，而不是固定在屏幕右下角。 */
function voiceOrbFrame() {
  const base = voiceOverlayFrame || readVoiceOverlayFrame() || {
    x: 0, y: 0, width: 392, height: 400,
  };
  const display = displayForFrame({
    x: base.x,
    y: base.y,
    width: VOICE_ORB_SIZE,
    height: VOICE_ORB_SIZE,
  });
  const area = display.workArea && display.workArea.width > 0 ? display.workArea : display.bounds;
  const maxX = area.x + area.width - VOICE_ORB_SIZE;
  const maxY = area.y + area.height - VOICE_ORB_SIZE;
  return {
    x: Math.round(Math.min(Math.max(base.x + base.width - VOICE_ORB_SIZE, area.x), maxX)),
    y: Math.round(Math.min(Math.max(base.y, area.y), maxY)),
    width: VOICE_ORB_SIZE,
    height: VOICE_ORB_SIZE,
  };
}

function stopVoiceOrbDrag(): void {
  if (voiceOrbDragTimer) {
    clearInterval(voiceOrbDragTimer);
    voiceOrbDragTimer = null;
  }
  if (voiceOrbDragSafety) {
    clearTimeout(voiceOrbDragSafety);
    voiceOrbDragSafety = null;
  }
  voiceOrbDragPos = null;
  voiceOrbDragLastCursor = null;
}

function moveVoiceOrbWithCursor(): void {
  const win = voiceOrb;
  if (!win || !voiceOrbDragPos) {
    stopVoiceOrbDrag();
    return;
  }
  const cursor = Screen.getCursorScreenPoint();
  // 第一帧只记录基准，不移动：避免初始光标读数偏差被当成一次大位移。
  if (!voiceOrbDragLastCursor) {
    voiceOrbDragLastCursor = { x: cursor.x, y: cursor.y };
    return;
  }
  const dx = cursor.x - voiceOrbDragLastCursor.x;
  const dy = cursor.y - voiceOrbDragLastCursor.y;
  voiceOrbDragLastCursor = { x: cursor.x, y: cursor.y };
  if (!dx && !dy) return;

  const width = VOICE_ORB_SIZE;
  const height = VOICE_ORB_SIZE;
  const next = { x: voiceOrbDragPos.x + dx, y: voiceOrbDragPos.y + dy, width, height };
  const display = displayForFrame(next);
  const area = display.workArea && display.workArea.width > 0 ? display.workArea : display.bounds;
  voiceOrbDragPos = {
    x: Math.min(Math.max(next.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(next.y, area.y), area.y + area.height - height),
  };
  try {
    win.setPosition(Math.round(voiceOrbDragPos.x), Math.round(voiceOrbDragPos.y));
  } catch (error) {
    stopVoiceOrbDrag();
  }
}

function startVoiceOrbDrag(): void {
  if (!voiceOrb) return;
  stopVoiceOrbDrag();
  const frame = voiceOrb.getFrame();
  voiceOrbDragPos = { x: frame.x, y: frame.y };
  voiceOrbDragLastCursor = null;
  voiceOrbDragged = true;
  // 用系统光标位置的增量驱动，避免绝对坐标或窗口反馈造成跳变。
  voiceOrbDragTimer = setInterval(moveVoiceOrbWithCursor, 16);
  voiceOrbDragSafety = setTimeout(stopVoiceOrbDrag, 30000);
}

function hideVoiceOrb(): void {
  stopVoiceOrbDrag();
  voiceOrbVisible = false;
  voiceOrbCursorInside = false;
  if (!voiceOrb) return;
  try { voiceOrb.hide(); } catch (error) { /* 已关闭 */ }
}

/** 从 Logo 展开时，让浮层右上角对齐 Logo 的右上角；拖过 Logo 也会带到浮层。 */
function placeVoiceOverlayAtOrb(): void {
  if (!voiceOrb) return;
  try {
    const orbFrame = voiceOrb.getFrame();
    const display = displayForFrame(orbFrame);
    const area = display.workArea && display.workArea.width > 0 ? display.workArea : display.bounds;
    const x = Math.min(
      Math.max(orbFrame.x + orbFrame.width - VOICE_OVERLAY_WIDTH, area.x),
      area.x + area.width - VOICE_OVERLAY_WIDTH,
    );
    const y = Math.min(
      Math.max(orbFrame.y, area.y),
      area.y + area.height - VOICE_OVERLAY_HEIGHT,
    );
    voiceOverlayFrame = { x: Math.round(x), y: Math.round(y), width: VOICE_OVERLAY_WIDTH, height: VOICE_OVERLAY_HEIGHT };
    saveVoiceOverlayFrame(voiceOverlayFrame);
    if (voiceOverlay) {
      try { voiceOverlay.setFrame(voiceOverlayFrame.x, voiceOverlayFrame.y, VOICE_OVERLAY_WIDTH, VOICE_OVERLAY_HEIGHT); } catch (error) { /* 忽略 */ }
    }
  } catch (error) {
    logLine("按 Logo 定位浮层失败: " + error);
  }
}

/** 浮层收起后留下一个可点击的圆形 Logo；再点它恢复浮层。 */
async function showVoiceOrb(): Promise<void> {
  if (voiceOrbPending) return;
  if (!readVoiceEnabled() || panel || voiceOverlayVisible) return;
  voiceOrbPending = true;
  try {
    const frame = voiceOrbFrame();
    if (!voiceOrb) {
      const win = new BrowserWindow({
        title: "mo-agent 语音",
        url: BASE + "/voice-orb.html",
        frame,
        titleBarStyle: "hidden",
        transparent: true,
        hidden: true,
        activate: false,
        styleMask: {
          Borderless: true,
          Titled: false,
          Closable: false,
          Miniaturizable: false,
          Resizable: false,
          FullScreen: false,
          FullSizeContentView: true,
          UtilityWindow: true,
          NonactivatingPanel: false,
        },
      });
      voiceOrb = win;
      try {
        win.setAlwaysOnTop(true);
        win.setVisibleOnAllWorkspaces(true);
      } catch (error) {
        logLine("语音浮层球置顶失败: " + error);
      }
      const webview = win.webview as unknown as {
        on?: (name: string, handler: (event: unknown) => void) => void;
      } | undefined;
      if (webview && typeof webview.on === "function") {
        webview.on("host-message", (event: unknown) => {
          const detail = (event as { data?: { detail?: unknown } } | null)?.data?.detail;
          if (!detail || typeof detail !== "object") return;
          const message = detail as { type?: string; dx?: number; dy?: number };
          if (message.type === "overlay-show") {
            placeVoiceOverlayAtOrb();
            syncVoiceOverlay().catch((error) => logLine("显示语音浮层失败: " + error));
            return;
          }
          if (message.type === "orb-drag-start") {
            startVoiceOrbDrag();
            return;
          }
          if (message.type === "orb-drag-end") {
            stopVoiceOrbDrag();
          }
        });
      }
      win.on("close", () => {
        stopVoiceOrbDrag();
        voiceOrbVisible = false;
        voiceOrbCursorInside = false;
        if (voiceOrb === win) voiceOrb = null;
      });
      // 透明窗口先预热一帧，避免首次出现时闪一下不透明底色。
      await new Promise(function (resolve) { setTimeout(resolve, 240); });
    } else if (!voiceOrbDragged) {
      try { voiceOrb.setFrame(frame.x, frame.y, frame.width, frame.height); } catch (error) { /* 忽略 */ }
    }

    if (!readVoiceEnabled() || panel || voiceOverlayVisible || !voiceOrb) return;
    try {
      voiceOrb.show();
      voiceOrb.activate();
      voiceOrbVisible = true;
    } catch (error) {
      logLine("显示语音浮层球失败: " + error);
    }
  } finally {
    voiceOrbPending = false;
  }
}

function pointInsideFrame(point: { x: number; y: number }, frame: { x: number; y: number; width: number; height: number }) {
  return point.x >= frame.x && point.x <= frame.x + frame.width
    && point.y >= frame.y && point.y <= frame.y + frame.height;
}

/**
 * macOS 对未激活窗口的第一次点击通常只用来激活窗口，不会送进 webview。
 * 这里在光标“刚移入”窗口时先激活，避免用户需要点第二次。
 */
function focusVisibleOverlayOnCursorEnter(): void {
  let point: { x: number; y: number };
  try {
    point = Screen.getCursorScreenPoint();
  } catch (error) {
    return;
  }

  if (voiceOverlayVisible && voiceOverlay) {
    try {
      const inside = pointInsideFrame(point, voiceOverlay.getFrame());
      if (inside && !voiceOverlayCursorInside) {
        voiceOverlay.show();
        voiceOverlay.activate();
      }
      voiceOverlayCursorInside = inside;
    } catch (error) {
      voiceOverlayCursorInside = false;
    }
  } else {
    voiceOverlayCursorInside = false;
  }

  if (voiceOrbVisible && voiceOrb) {
    try {
      const inside = pointInsideFrame(point, voiceOrb.getFrame());
      if (inside && !voiceOrbCursorInside) {
        voiceOrb.show();
        voiceOrb.activate();
      }
      voiceOrbCursorInside = inside;
    } catch (error) {
      voiceOrbCursorInside = false;
    }
  } else {
    voiceOrbCursorInside = false;
  }
}

function syncVoiceOrb(): void {
  if (!readVoiceEnabled() || panel || voiceOverlayVisible) {
    hideVoiceOrb();
    return;
  }
  void showVoiceOrb().catch((error) => logLine("显示语音浮层球失败: " + error));
}

/** 语音开启时浮层常驻；关闭语音、设置窗口打开或手动隐藏时保持收起。 */
async function syncVoiceOverlay(): Promise<void> {
  if (!readVoiceEnabled() || panel) return;
  try {
    await ensureVoiceOverlay();
  } catch (error) {
    logLine("显示语音浮层失败: " + error);
  }
}

function voiceOverlayShortcutLabel(): string {
  return VOICE_OVERLAY_SHORTCUT
    .replace(/CommandOrControl/g, "⌘")
    .replace(/Command/g, "⌘")
    .replace(/Control/g, "⌃")
    .replace(/Option/g, "⌥")
    .replace(/Alt/g, "⌥")
    .replace(/Shift/g, "⇧")
    .replace(/\+/g, "");
}

async function toggleVoiceOverlay(): Promise<void> {
  if (!readVoiceEnabled() || panel) return;
  if (voiceOverlayVisible) hideVoiceOverlay();
  else await syncVoiceOverlay();
}

/** 只有启用语音时才占用全局快捷键；关闭语音立即释放。 */
function syncVoiceOverlayShortcut(): void {
  const enabled = readVoiceEnabled();
  if (enabled && !voiceOverlayShortcutRegistered) {
    const ok = GlobalShortcut.register(VOICE_OVERLAY_SHORTCUT_KEY, () => {
      const now = Date.now();
      // 全局监控 + 本地监控可能对同一次按键各回调一次，去重避免“隐藏又显示”。
      if (now - lastOverlayShortcutAt < 300) return;
      lastOverlayShortcutAt = now;
      logLine("全局快捷键: 切换语音浮层");
      toggleVoiceOverlay().catch((error) => logLine("切换语音浮层失败: " + error));
    });
    voiceOverlayShortcutRegistered = ok;
    if (ok) {
      logLine("语音浮层快捷键已注册: " + voiceOverlayShortcutLabel());
      if (checkAccessibilityTrust() === false) {
        logLine("语音浮层快捷键未获辅助功能权限：只在 mo-agent 处于前台时生效");
      }
    } else {
      logLine("语音浮层快捷键注册失败（可能被其他 App 占用）: " + VOICE_OVERLAY_SHORTCUT);
    }
  } else if (!enabled && voiceOverlayShortcutRegistered) {
    GlobalShortcut.unregister(VOICE_OVERLAY_SHORTCUT_KEY);
    voiceOverlayShortcutRegistered = false;
    logLine("语音浮层快捷键已释放");
  }
}

function displayForFrame(frame: { x: number; y: number; width: number; height: number }) {
  const displays = Screen.getAllDisplays();
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  const containsCenter = displays.find(function (display) {
    const area = display.bounds;
    return centerX >= area.x && centerX <= area.x + area.width
      && centerY >= area.y && centerY <= area.y + area.height;
  });
  if (containsCenter) return containsCenter;
  const overlaps = displays.find(function (display) {
    const area = display.bounds;
    return frame.x < area.x + area.width && frame.x + frame.width > area.x
      && frame.y < area.y + area.height && frame.y + frame.height > area.y;
  });
  return overlaps || Screen.getPrimaryDisplay();
}

/** 左右/下/上都不允许拖出屏幕：停下后贴边，越界则拉回最近的可视边缘。 */
function snapVoiceOverlayToScreen(): void {
  const win = voiceOverlay;
  if (!win || !voiceOverlayVisible) return;
  try {
    const frame = win.getFrame();
    const display = displayForFrame(frame);
    const area = display.workArea && display.workArea.width > 0 ? display.workArea : display.bounds;
    if (!area || area.width <= 0 || area.height <= 0) return;

    let x = frame.x;
    let y = frame.y;
    if (frame.width >= area.width) x = area.x;
    else if (x <= area.x + VOICE_OVERLAY_SNAP_MARGIN) x = area.x;
    else if (x + frame.width >= area.x + area.width - VOICE_OVERLAY_SNAP_MARGIN) x = area.x + area.width - frame.width;

    if (frame.height >= area.height) y = area.y;
    else if (y <= area.y + VOICE_OVERLAY_SNAP_MARGIN) y = area.y;
    else if (y + frame.height >= area.y + area.height - VOICE_OVERLAY_SNAP_MARGIN) y = area.y + area.height - frame.height;

    const nextX = Math.round(x);
    const nextY = Math.round(y);
    if (nextX === frame.x && nextY === frame.y) return;
    // 越界很多时不要瞬移回来：用 ease-out 补一段短动画，视觉上像被边缘“吸”回去。
    animateVoiceOverlayTo(win, nextX, nextY, frame);
  } catch (error) {
    logLine("语音浮层吸附失败: " + error);
  }
}

function cancelVoiceOverlaySnapAnimation(): void {
  if (voiceOverlaySnapAnimationTimer) {
    clearTimeout(voiceOverlaySnapAnimationTimer);
    voiceOverlaySnapAnimationTimer = null;
  }
  voiceOverlaySnapAnimating = false;
}

function cancelVoiceOverlaySnap(): void {
  if (voiceOverlaySnapTimer) {
    clearTimeout(voiceOverlaySnapTimer);
    voiceOverlaySnapTimer = null;
  }
  cancelVoiceOverlaySnapAnimation();
}

function animateVoiceOverlayTo(
  win: BrowserWindow,
  targetX: number,
  targetY: number,
  from: { x: number; y: number; width: number; height: number },
): void {
  cancelVoiceOverlaySnapAnimation();
  const distance = Math.hypot(targetX - from.x, targetY - from.y);
  const duration = Math.min(220, Math.max(70, Math.round(distance * 1.1)));
  const startedAt = Date.now();
  voiceOverlaySnapAnimating = true;

  const step = function () {
    voiceOverlaySnapAnimationTimer = null;
    if (voiceOverlay !== win || !voiceOverlayVisible) {
      voiceOverlaySnapAnimating = false;
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const x = Math.round(from.x + (targetX - from.x) * eased);
    const y = Math.round(from.y + (targetY - from.y) * eased);
    try {
      win.setPosition(x, y);
    } catch (error) {
      logLine("语音浮层吸附动画失败: " + error);
      voiceOverlaySnapAnimating = false;
      return;
    }
    voiceOverlayFrame = { x, y, width: from.width, height: from.height };
    if (progress < 1) {
      voiceOverlaySnapAnimationTimer = setTimeout(step, 16);
    } else {
      voiceOverlaySnapAnimating = false;
      saveVoiceOverlayFrame(voiceOverlayFrame);
    }
  };
  step();
}

function scheduleVoiceOverlaySnap(): void {
  if (voiceOverlaySnapAnimating) return;
  if (voiceOverlaySnapTimer) clearTimeout(voiceOverlaySnapTimer);
  voiceOverlaySnapTimer = setTimeout(function () {
    voiceOverlaySnapTimer = null;
    snapVoiceOverlayToScreen();
  }, VOICE_OVERLAY_SNAP_DELAY_MS);
}

/** 磨砂半透明浮层：置顶、不抢焦点、可拖动。 */
async function ensureVoiceOverlay(): Promise<boolean> {
  const token = readLocalToken();
  if (!token) return false;

  // host 重启后本机 token 会变；旧浮层的 SSE 会 401，必须重建。
  if (voiceOverlay && voiceOverlayToken !== token) {
    try { voiceOverlay.close(); } catch (error) { /* 忽略 */ }
    voiceOverlay = null;
  }

  if (!voiceOverlay) {
    // 第一次打开不传 x/y，交给系统居中；之后用上次保存的位置。
    const frame: { x?: number; y?: number; width: number; height: number } = voiceOverlayFrame
      ? { x: voiceOverlayFrame.x, y: voiceOverlayFrame.y, width: VOICE_OVERLAY_WIDTH, height: VOICE_OVERLAY_HEIGHT }
      : { width: VOICE_OVERLAY_WIDTH, height: VOICE_OVERLAY_HEIGHT };
    const win = new BrowserWindow({
      title: "mo-agent 语音",
      url: BASE + "/voice-overlay.html?token=" + encodeURIComponent(token),
      frame,
      titleBarStyle: "hidden",
      transparent: true,
      hidden: true,
      activate: false,
      styleMask: {
        Borderless: true,
        Titled: false,
        Closable: false,
        Miniaturizable: false,
        Resizable: false,
        FullScreen: false,
        FullSizeContentView: true,
        UtilityWindow: true,
        // 不使用 NonactivatingPanel：显示/鼠标移入时需要能真正获取焦点。
        NonactivatingPanel: false,
      },
    });
    voiceOverlay = win;
    voiceOverlayToken = token;
    try {
      win.setAlwaysOnTop(true);
      win.setVisibleOnAllWorkspaces(true);
    } catch (error) {
      logLine("语音浮层置顶失败: " + error);
    }
    // 浮层里的 × 通过 host-message 请求桌面端隐藏，而不是直接 window.close()。
    const webview = win.webview as unknown as {
      on?: (name: string, handler: (event: unknown) => void) => void;
    } | undefined;
    if (webview && typeof webview.on === "function") {
      webview.on("host-message", (event: unknown) => {
        const detail = (event as { data?: { detail?: unknown } } | null)?.data?.detail;
        if (!detail || typeof detail !== "object") return;
        const type = (detail as { type?: string }).type;
        if (type === "overlay-hide") hideVoiceOverlay();
        else if (type === "overlay-focus") {
          // 鼠标移入浮层时主动拿焦点，键盘/快捷键操作不再落到后面的窗口。
          try { win.show(); win.activate(); } catch (error) { logLine("语音浮层获取焦点失败: " + error); }
        }
      });
    }
    // 拖动期间事件很密：停下 160ms 再吸附，避免和系统拖动互相打架。
    win.on("move", () => { scheduleVoiceOverlaySnap(); });
    win.on("close", () => {
      cancelVoiceOverlaySnap();
      try {
        voiceOverlayFrame = win.getFrame();
        saveVoiceOverlayFrame(voiceOverlayFrame);
      } catch (error) { /* 忽略 */ }
      if (voiceOverlay === win) {
        voiceOverlay = null;
        voiceOverlayVisible = false;
        refreshTrayMenu();
      }
    });
    // 首次居中后把实际位置记下来；之后拖动/隐藏会更新。
    try {
      voiceOverlayFrame = win.getFrame();
      saveVoiceOverlayFrame(voiceOverlayFrame);
    } catch (error) { /* 忽略 */ }
    // 先在隐藏状态下把页面/透明合成跑起来，再 show，避免第一帧出现不透明的底色。
    await new Promise(function (resolve) { setTimeout(resolve, 420); });
  }

  try {
    // show() 会激活窗口并获取焦点；showInactive() 只显示、不抢焦点。
    voiceOverlay.show();
  } catch (error) {
    logLine("显示语音浮层失败: " + error);
    voiceOverlay = null;
    voiceOverlayVisible = false;
    return false;
  }
  voiceOverlayVisible = true;
  refreshTrayMenu();
  hideVoiceOrb();
  // 旧位置可能来自已拔掉的显示器；显示后同样校正到当前屏幕可视区域。
  scheduleVoiceOverlaySnap();
  return true;
}

/** P1：点一次、说一条命令；实时识别与结果都显示在浮层，播报由 host 负责。 */
async function runVoiceCommand(): Promise<void> {
  const ready = await ensureHost();
  if (!ready) {
    await Utils.showMessageBox({ type: "warning", title: "语音命令", message: "本地服务没起来", detail: "先看菜单里的「查看日志」" });
    return;
  }

  const token = readLocalToken();
  if (!token) {
    await Utils.showMessageBox({ type: "warning", title: "语音命令", message: "找不到本机令牌", detail: "先重启一次服务" });
    return;
  }

  let overlayReady = false;
  try {
    overlayReady = await ensureVoiceOverlay();
  } catch (error) {
    logLine("创建语音浮层失败: " + error);
  }

  try {
    const result = await postLocal("/local/voice-command", 180000);
    // 正常路径只用浮层显示；浮层起不来时才退回弹框，避免没有反馈。
    if (!overlayReady) {
      await Utils.showMessageBox({
        type: result.ok ? "info" : "warning",
        title: "语音命令",
        message: result.reply || (result.error ? ("失败：" + result.error) : "没有结果"),
        detail: result.heard && result.heard.text ? ("听到：" + result.heard.text) : "没有识别到有效命令。",
      });
    }
  } catch (error) {
    logLine("语音命令请求失败: " + error);
    if (!overlayReady) {
      await Utils.showMessageBox({ type: "warning", title: "语音命令", message: "请求失败", detail: String(error) });
    }
  }
}

/** P2：点一次、说一段任务；草稿与「已发送给 X」都显示在同一个浮层。 */
async function runDictate(): Promise<void> {
  const ready = await ensureHost();
  if (!ready) {
    await Utils.showMessageBox({ type: "warning", title: "语音口述任务", message: "本地服务没起来", detail: "先看菜单里的「查看日志」" });
    return;
  }

  const token = readLocalToken();
  if (!token) {
    await Utils.showMessageBox({ type: "warning", title: "语音口述任务", message: "找不到本机令牌", detail: "先重启一次服务" });
    return;
  }

  let overlayReady = false;
  try {
    overlayReady = await ensureVoiceOverlay();
  } catch (error) {
    logLine("创建语音浮层失败: " + error);
  }

  try {
    const result = await postLocal("/local/dictate", 180000);
    // 正常路径只用浮层显示；浮层起不来时才退回弹框，避免没有反馈。
    if (!overlayReady) {
      const draft = result.draft && result.draft.text ? ("草稿：" + result.draft.text) : "没有形成草稿。";
      const target = result.target && result.target.title ? ("目标：" + result.target.title + " · ") : "";
      await Utils.showMessageBox({
        type: result.ok ? "info" : "warning",
        title: "语音口述任务",
        message: result.reply || (result.error ? ("失败：" + result.error) : "没有结果"),
        detail: target + draft,
      });
    }
  } catch (error) {
    logLine("语音口述请求失败: " + error);
    if (!overlayReady) {
      await Utils.showMessageBox({ type: "warning", title: "语音口述任务", message: "请求失败", detail: String(error) });
    }
  }
}

async function runVoiceTest(): Promise<void> {
  const ready = await ensureHost();
  if (!ready) {
    await Utils.showMessageBox({ type: "warning", title: "语音测试", message: "本地服务没起来", detail: "先看菜单里的「查看日志」" });
    return;
  }

  const token = readLocalToken();
  if (!token) {
    await Utils.showMessageBox({ type: "warning", title: "语音测试", message: "找不到本机令牌", detail: "先重启一次服务" });
    return;
  }

  let overlayReady = false;
  try {
    overlayReady = await ensureVoiceOverlay();
  } catch (error) {
    logLine("创建语音浮层失败: " + error);
  }

  try {
    const result = await postLocal("/local/voice-test", 120000);
    // 测试结果也走浮层；浮层起不来时才退回弹框。
    if (!overlayReady) {
      const heard = Array.isArray(result.heard)
        ? result.heard.map(function (item: any) { return item.text; }).filter(Boolean).join(" / ")
        : "";
      await Utils.showMessageBox({
        type: result.ok && result.outcome === "allow" ? "info" : "warning",
        title: "语音测试",
        message: result.ok ? ("结果：" + result.outcome) : ("失败：" + (result.error || "unknown")),
        detail: heard ? ("听到：" + heard) : "没有识别到有效回答。",
      });
    }
  } catch (error) {
    logLine("语音测试请求失败: " + error);
    if (!overlayReady) {
      await Utils.showMessageBox({ type: "warning", title: "语音测试", message: "请求失败", detail: String(error) });
    }
  }
}

const tray = new Tray({ image: "views://mainview/tray.png", template: true, width: 18, height: 18 });

tray.setMenu(trayMenu());
syncVoiceOverlayShortcut();
// 未激活窗口的第一次点击只会激活窗口；光标刚移入时先激活，保证第一次点击就生效。
const focusPoll = setInterval(focusVisibleOverlayOnCursorEnter, 40);
if (typeof focusPoll.unref === "function") focusPoll.unref();

tray.on("tray-clicked", async (event: any) => {
  const action = event?.data?.action;
  if (action === "panel") await openPanel();
  else if (action === "voice") await toggleVoice();
  else if (action === "voice-command") await runVoiceCommand();
  else if (action === "dictate") await runDictate();
  else if (action === "voice-test") await runVoiceTest();
  else if (action === "toggle-overlay") await toggleVoiceOverlay();
  else if (action === "mic-settings") openMicSettings();
  else if (action === "accessibility-settings") openAccessibilitySettings();
  else if (action === "restart") await restartHost();
  else if (action === "logs") await openLogs();
  else if (action === "quit") {
    GlobalShortcut.unregisterAll();
    hideVoiceOverlay(false);
    hideVoiceOrb();
    if (host) host.kill();
    tray.remove();
    process.exit(0);
  }
});

ensureHost().then(async (ready) => {
  logLine(ready ? "服务已就绪: " + PANEL_URL : "服务启动失败（详见 " + LOG_DIR + "）");
  // 启动后默认打开「设置（安装与配对）」面板
  if (ready) {
    await openPanel();
    // 启动时设置窗口在前；浮层等设置窗口关闭后由 close 事件显示。
    await syncVoiceOverlay();
  }
}).catch((error) => logLine("启动流程异常: " + error));

