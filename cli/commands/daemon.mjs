/**
 * mo daemon start|stop|status
 *
 * daemon 就是 host（桌面 App 里那个常驻服务）。CLI 起它有两种来源：
 *   1. 桌面版装好的运行时：~/Library/Application Support/mo-agent/runtime/bin/mo-agent-host
 *   2. 源码仓库：<repo>/host/index.mjs（需要 node/bun）
 *
 * 单文件 CLI 本身不含 host 与前端资源，所以它只能"拉起"已存在的运行时，
 * 不能凭空造一个。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MoError } from "../../core/errors.mjs";
import { readGlobalConfig } from "../lib/config.mjs";
import { fetchApk, apkDest } from "../lib/apk.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = (home) => path.join(home, ".mo-agent", "daemon.pid");

function isCompiledBinary() {
  // bun --compile 出来的可执行文件：execPath 不是 bun/node 本身
  return Boolean(process.versions.bun) && !/^(bun|node)$/i.test(path.basename(process.execPath));
}

/** 找一个能跑 host 的根目录；返回 {root, kind, command} 或 null */
export function findHost({ env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  const candidates = [];
  if (env.MO_AGENT_ROOT) candidates.push({ root: path.resolve(env.MO_AGENT_ROOT), kind: "env" });
  candidates.push({ root: path.join(home, "Library", "Application Support", "mo-agent", "runtime"), kind: "desktop" });
  candidates.push({ root: path.join(home, ".mo-agent", "runtime"), kind: "desktop" });

  let dir = path.resolve(cwd);
  for (;;) {
    candidates.push({ root: dir, kind: "source" });
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  for (const c of candidates) {
    const bin = path.join(c.root, "bin", "mo-agent-host");
    if (fs.existsSync(bin)) return { root: c.root, kind: c.kind, command: [bin], args: [] };
  }
  for (const c of candidates) {
    const entry = path.join(c.root, "host", "index.mjs");
    if (fs.existsSync(entry)) {
      if (isCompiledBinary()) continue; // 单文件 CLI 不能当 node 用
      return { root: c.root, kind: c.kind, command: [process.execPath, entry], args: [] };
    }
  }
  return null;
}

function readConfigPort(env, home) {
  try {
    const file = readGlobalConfig({ home, env });
    const port = Number(file.values && file.values.port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch {
    // 配置坏了就用默认
  }
  return Number(env.MO_AGENT_PORT) || 7788;
}

function readPid(home) {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE(home), "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/api/health", { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitHealthy(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await health(port);
    if (body) return body;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function start(ctx, args) {
  const home = os.homedir();
  const env = ctx.env || process.env;
  const opts = args.options || {};
  const foreground = Boolean(opts.foreground);
  const port = Number(opts.port) || readConfigPort(env, home);

  const existing = readPid(home);
  if (existing && alive(existing.pid)) {
    throw new MoError("E_DAEMON_RUNNING", "daemon 已在运行（pid " + existing.pid + "，端口 " + existing.port + "）", {
      hint: "要重启先 mo daemon stop",
    });
  }

  const host = findHost({ env, home, cwd: ctx.cwd });
  if (!host) {
    throw new MoError("E_NO_HOST", "找不到可运行的 host", {
      hint: isCompiledBinary()
        ? "单文件 CLI 不含 host。装桌面版（installer 里的 get-desktop）或设置 MO_AGENT_ROOT 指向源码/运行时"
        : "在仓库根目录执行，或设置 MO_AGENT_ROOT",
    });
  }

  // 顺手把 APK 备好，这样手机扫码就能装（没有 Release 就跳过，不影响启动）
  let apk = null;
  try {
    apk = await fetchApk({ home, env, log: (line) => process.stdout.write("  " + line + "\n") });
  } catch (error) {
    process.stderr.write("  （APK 未准备好：" + error.message + "，/app.apk 会提示去下载）\n");
  }

  const [cmd, ...cmdRest] = host.command;
  const spawnArgs = [...cmdRest, "--port", String(port)];

  const child = spawn(cmd, spawnArgs, {
    cwd: host.root,
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    env: { ...env, MO_AGENT_ROOT: host.root, MO_AGENT_NO_PARENT_WATCH: "1" },
  });

  if (!foreground) {
    child.unref();
    fs.mkdirSync(path.dirname(PID_FILE(home)), { recursive: true });
    fs.writeFileSync(PID_FILE(home), JSON.stringify({ pid: child.pid, port, root: host.root, startedAt: new Date().toISOString() }, null, 2));
  }

  if (foreground) {
    return new Promise((resolve) => {
      child.on("exit", (code) => resolve(code || 0));
    });
  }

  const body = await waitHealthy(port);
  if (!body) {
    throw new MoError("E_DAEMON_START_FAILED", "daemon 启动了但没响应（pid " + child.pid + "，端口 " + port + "）", {
      hint: "看 ~/Library/Logs/mo-agent/host.log",
    });
  }

  process.stdout.write("✓ daemon 已启动\n");
  process.stdout.write("  pid   " + child.pid + "\n");
  process.stdout.write("  地址  http://127.0.0.1:" + port + "/\n");
  process.stdout.write("  配对  http://127.0.0.1:" + port + "/pair\n");
  process.stdout.write("  安装  http://127.0.0.1:" + port + "/app.apk" + (apk && fs.existsSync(apk.path) ? "（已就绪）" : "（未就绪）") + "\n");
  process.stdout.write("  停止  mo daemon stop\n");
  return 0;
}

async function stop() {
  const home = os.homedir();
  const info = readPid(home);
  if (!info || !alive(info.pid)) {
    fs.rmSync(PID_FILE(home), { force: true });
    process.stdout.write("daemon 没在运行\n");
    return 0;
  }

  process.kill(info.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && alive(info.pid)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (alive(info.pid)) process.kill(info.pid, "SIGKILL");
  fs.rmSync(PID_FILE(home), { force: true });
  process.stdout.write("✓ daemon 已停止（pid " + info.pid + "）\n");
  return 0;
}

async function status() {
  const home = os.homedir();
  const info = readPid(home);
  if (!info || !alive(info.pid)) {
    process.stdout.write("daemon  未运行\n");
    return 1;
  }
  const body = await health(info.port);
  process.stdout.write("daemon  运行中（pid " + info.pid + "，端口 " + info.port + "）\n");
  process.stdout.write("  健康检查  " + (body ? "✓" : "✗ 无响应") + "\n");
  process.stdout.write("  APK       " + (fs.existsSync(apkDest(home)) ? "✓ " + apkDest(home) : "未下载（mo daemon start 时会自动拉）") + "\n");
  return body ? 0 : 1;
}

export async function daemonCommand(ctx, args) {
  const sub = (args.positional || [])[0];
  if (!sub || sub === "status") return status();
  if (sub === "start") return start(ctx, args);
  if (sub === "stop") return stop();
  throw new MoError("E_USAGE", "未知子命令：" + sub, { hint: "mo daemon start|stop|status" });
}
