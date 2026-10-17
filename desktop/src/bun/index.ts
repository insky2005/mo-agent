import { Tray, BrowserWindow, Utils } from "electrobun/main";
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
// 测试时静音推送：host 每条通知实时读取，不需要重启。
const QUIET_CONFIG = join(homedir(), ".mo-agent", "quiet.json");

function readVoiceEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(VOICE_CONFIG, "utf8"));
    return Boolean(parsed && parsed.enabled === true);
  } catch (error) {
    return false;
  }
}

function readQuietEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(QUIET_CONFIG, "utf8"));
    return Boolean(parsed && parsed.enabled === true);
  } catch (error) {
    return false;
  }
}

function writeQuietEnabled(enabled: boolean): void {
  try {
    mkdirSync(dirname(QUIET_CONFIG), { recursive: true });
    writeFileSync(QUIET_CONFIG, JSON.stringify({ enabled }, null, 2) + "\n");
  } catch (error) {
    logLine("写入通知静音配置失败: " + error);
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
const VOICE_OVERLAY_HEIGHT = 272;

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
let voiceOverlayHideTimer: ReturnType<typeof setTimeout> | null = null;

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
    win.on("close", () => { if (panel === win) panel = null; });
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
  cancelVoiceOverlayHide();
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
}

async function restartHost(): Promise<void> {
  return restartService(true);
}

function trayMenu(): any[] {
  const voice = readVoiceEnabled();
  const quiet = readQuietEnabled();
  return [
    { type: "normal", label: "设置（安装与配对）", action: "panel" },
    {
      type: "normal",
      label: "语音",
      submenu: [
        { type: "normal", label: "启用语音", action: "voice", checked: voice },
        { type: "normal", label: "麦克风权限设置…", action: "mic-settings" },
        { type: "divider" },
        { type: "normal", label: "语音命令", action: "voice-command" },
        { type: "normal", label: "语音测试", action: "voice-test" },
      ],
    },
    { type: "normal", label: "暂停通知（测试）", action: "quiet", checked: quiet },
    { type: "divider" },
    { type: "normal", label: "重启服务", action: "restart" },
    { type: "normal", label: "查看日志", action: "logs" },
    { type: "divider" },
    { type: "normal", label: "退出", action: "quit" },
  ];
}

function toggleQuiet(): void {
  const enabled = !readQuietEnabled();
  writeQuietEnabled(enabled);
  tray.setMenu(trayMenu());
  logLine("测试静音通知: " + (enabled ? "开启" : "关闭"));
}

async function toggleVoice(): Promise<void> {
  const enabled = !readVoiceEnabled();
  writeVoiceEnabled(enabled);
  tray.setMenu(trayMenu());
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

function cancelVoiceOverlayHide(): void {
  if (!voiceOverlayHideTimer) return;
  clearTimeout(voiceOverlayHideTimer);
  voiceOverlayHideTimer = null;
}

function hideVoiceOverlay(): void {
  cancelVoiceOverlayHide();
  if (!voiceOverlay) return;
  try {
    voiceOverlayFrame = voiceOverlay.getFrame();
    saveVoiceOverlayFrame(voiceOverlayFrame);
  } catch (error) { /* 忽略 */ }
  try { voiceOverlay.hide(); } catch (error) { /* 已关闭 */ }
}

function scheduleVoiceOverlayHide(delayMs: number): void {
  cancelVoiceOverlayHide();
  voiceOverlayHideTimer = setTimeout(function () {
    voiceOverlayHideTimer = null;
    hideVoiceOverlay();
  }, delayMs);
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
        NonactivatingPanel: true,
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
    win.on("close", () => {
      try {
        voiceOverlayFrame = win.getFrame();
        saveVoiceOverlayFrame(voiceOverlayFrame);
      } catch (error) { /* 忽略 */ }
      if (voiceOverlay === win) voiceOverlay = null;
    });
    // 首次居中后把实际位置记下来；之后拖动/隐藏会更新。
    try {
      voiceOverlayFrame = win.getFrame();
      saveVoiceOverlayFrame(voiceOverlayFrame);
    } catch (error) { /* 忽略 */ }
    // 给页面和 SSE 一点连接时间，避免错过开头的事件。
    await new Promise(function (resolve) { setTimeout(resolve, 260); });
  }

  cancelVoiceOverlayHide();
  try {
    voiceOverlay.showInactive();
  } catch (error) {
    logLine("显示语音浮层失败: " + error);
    voiceOverlay = null;
    return false;
  }
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
    if (overlayReady) scheduleVoiceOverlayHide(result.ok ? 6500 : 4500);
  } catch (error) {
    logLine("语音命令请求失败: " + error);
    if (!overlayReady) {
      await Utils.showMessageBox({ type: "warning", title: "语音命令", message: "请求失败", detail: String(error) });
    } else {
      scheduleVoiceOverlayHide(3000);
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

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 120000);
  try {
    const response = await fetch(BASE + "/local/voice-test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mo-agent-local": token },
      body: "{}",
      signal: controller.signal,
    });
    const result = await response.json();
    const heard = Array.isArray(result.heard)
      ? result.heard.map(function (item: any) { return item.text; }).filter(Boolean).join(" / ")
      : "";
    await Utils.showMessageBox({
      type: result.ok && result.outcome === "allow" ? "info" : "warning",
      title: "语音测试",
      message: result.ok ? ("结果：" + result.outcome) : ("失败：" + (result.error || "unknown")),
      detail: heard ? ("听到：" + heard) : "没有识别到有效回答。",
    });
  } catch (error) {
    await Utils.showMessageBox({ type: "warning", title: "语音测试", message: "请求失败", detail: String(error) });
  } finally {
    clearTimeout(timer);
  }
}

const tray = new Tray({ image: "views://mainview/tray.png", template: true, width: 18, height: 18 });

tray.setMenu(trayMenu());

tray.on("tray-clicked", async (event: any) => {
  const action = event?.data?.action;
  if (action === "panel") await openPanel();
  else if (action === "voice") await toggleVoice();
  else if (action === "quiet") toggleQuiet();
  else if (action === "voice-command") await runVoiceCommand();
  else if (action === "voice-test") await runVoiceTest();
  else if (action === "mic-settings") openMicSettings();
  else if (action === "restart") await restartHost();
  else if (action === "logs") await openLogs();
  else if (action === "quit") {
    hideVoiceOverlay();
    if (host) host.kill();
    tray.remove();
    process.exit(0);
  }
});

ensureHost().then((ready) => {
  logLine(ready ? "服务已就绪: " + PANEL_URL : "服务启动失败（详见 " + LOG_DIR + "）");
  // 启动后默认打开「设置（安装与配对）」面板
  if (ready) openPanel();
}).catch((error) => logLine("启动流程异常: " + error));

