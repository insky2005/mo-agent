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

// host 每次启动都会写 session.json（端口 + 本机令牌），用来找"不是我们拉起的"那个
function readSessionToken(home) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, ".mo-agent", "session.json"), "utf8"));
    return typeof info.token === "string" ? info.token : null;
  } catch {
    return null;
  }
}

export function readSessionPort(home) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, ".mo-agent", "session.json"), "utf8"));
    if (Number.isInteger(info.port) && info.port > 0) return info.port;
    if (typeof info.url === "string") {
      const port = Number(new URL(info.url).port);
      if (Number.isInteger(port) && port > 0) return port;
    }
    return null;
  } catch {
    return null;
  }
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

// 令牌只在 TTY 下直接打印；重定向到文件/CI 时给占位符，避免令牌进日志
export function formatLink(port, pathname, token, tty) {
  const base = "http://127.0.0.1:" + port + pathname;
  if (!token) return base;
  return tty ? base + "?token=" + token : base + "?token=<见 ~/.mo-agent/session.json>";
}

function linkWithToken(port, pathname, home) {
  return formatLink(port, pathname, readSessionToken(home), Boolean(process.stdout.isTTY));
}

function printAccess(port, home) {
  const apk = apkDest(home);
  process.stdout.write("  本机    http://127.0.0.1:" + port + "/\n");
  process.stdout.write("  监控    " + linkWithToken(port, "/monitor", home) + "\n");
  process.stdout.write("  配对    http://127.0.0.1:" + port + "/pair\n");
  process.stdout.write("  管理    " + linkWithToken(port, "/setup", home) + "\n");
  process.stdout.write("  安装    http://127.0.0.1:" + port + "/app.apk" + (fs.existsSync(apk) ? "（已就绪）" : "（未就绪：等 APK Release 发布后 mo daemon start 会自动下载）") + "\n");
}

// 刚起来的 host 写 session.json 可能比健康检查慢一点点，等它一下再拼带令牌的链接
async function waitForToken(home, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readSessionToken(home)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function printInfo(port, home, origin) {
  process.stdout.write("✓ host 已在运行（端口 " + port + "，" + origin + "）\n");
  printAccess(port, home);
}

async function start(ctx, args) {
  const home = os.homedir();
  const env = ctx.env || process.env;
  const opts = args.options || {};
  const foreground = Boolean(opts.foreground);
  const port = Number(opts.port) || readConfigPort(env, home);

  const existing = readPid(home);
  // pid 文件过期（进程没了）就清掉，别影响后面的判断
  if (existing && !alive(existing.pid)) fs.rmSync(PID_FILE(home), { force: true });

  // 端口上已经有 host 在应答（常见于桌面 App 已经跑着）：
  // 再起一个会撞端口，而且健康检查会"成功"在别人的进程上，误报自己启动成功。
  const probePorts = [...new Set([port, readSessionPort(home)].filter(Boolean))];
  let occupiedPort = null;
  for (const p of probePorts) {
    if (await health(p)) {
      occupiedPort = p;
      break;
    }
  }
  if (occupiedPort) {
    // 幂等：已经有一个 host 在跑，就把访问信息给出来，不再起第二个。
    // 顺手把 APK 备好，这样桌面 App 起的 host 也能扫码装。
    try {
      await fetchApk({ home, env, log: (line) => process.stdout.write("  " + line + "\n") });
    } catch {
      // 没有 APK Release 就算了，不影响信息输出
    }
    const owner = existing && alive(existing.pid) ? "mo daemon 启动的" : "可能来自桌面 App";
    await printInfo(occupiedPort, home, owner);
    process.stdout.write("  （不会再起第二个；要停它请用对应方式：桌面 App 退出 / mo daemon stop）\n");
    return 0;
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

  const logFile = path.join(home, ".mo-agent", "daemon.log");
  if (!foreground) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const errFd = foreground ? null : fs.openSync(logFile, "a");

  const child = spawn(cmd, spawnArgs, {
    cwd: host.root,
    detached: !foreground,
    stdio: foreground ? "inherit" : ["ignore", errFd, errFd],
    env: { ...env, MO_AGENT_ROOT: host.root, MO_AGENT_NO_PARENT_WATCH: "1" },
  });
  if (errFd !== null) fs.closeSync(errFd);

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
  if (!body || !alive(child.pid)) {
    // 子进程已经退出（端口被抢、依赖缺失等），别报"启动成功"
    try {
      fs.rmSync(PID_FILE(home), { force: true });
    } catch {
      // 清理失败不影响报错
    }
    throw new MoError(
      "E_DAEMON_START_FAILED",
      "daemon 没能起来（pid " + child.pid + "，端口 " + port + "）",
      { hint: "看日志：" + logFile },
    );
  }

  await waitForToken(home);
  process.stdout.write("✓ daemon 已启动（pid " + child.pid + "）\n");
  printAccess(port, home);
  process.stdout.write("  停止    mo daemon stop\n");
  return 0;
}

async function stop() {
  const home = os.homedir();
  const info = readPid(home);
  if (!info || !alive(info.pid)) {
    fs.rmSync(PID_FILE(home), { force: true });
    // 没有我们拉起的进程，但可能有一个外部 host（桌面 App）在跑——不要动它
    const port = readSessionPort(home) || readConfigPort(process.env, home);
    if (await health(port)) {
      process.stdout.write("有 host 在跑（端口 " + port + "），但不是 mo daemon 启动的，不做处理\n");
      process.stdout.write("  它可能来自桌面 App：请退出 App，或用那个入口停\n");
      return 2;
    }
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
    // 没有 pid 文件不代表没在跑：桌面 App 拉起的 host 同样在这个端口上
    const port = readSessionPort(home) || readConfigPort(process.env, home);
    const body = await health(port);
    if (body) {
      process.stdout.write("daemon  运行中（端口 " + port + "，不是 mo daemon 拉起的，可能是桌面 App）\n");
      process.stdout.write("  健康检查  ✓\n");
      process.stdout.write("  监控      " + linkWithToken(port, "/monitor", home) + "\n");
      process.stdout.write("  APK       " + (fs.existsSync(apkDest(home)) ? "✓ " + apkDest(home) : "未下载") + "\n");
      return 0;
    }
    process.stdout.write("daemon  未运行\n");
    return 1;
  }
  const body = await health(info.port);
  process.stdout.write("daemon  运行中（pid " + info.pid + "，端口 " + info.port + "）\n");
  process.stdout.write("  健康检查  " + (body ? "✓" : "✗ 无响应") + "\n");
  if (body) process.stdout.write("  监控      " + linkWithToken(info.port, "/monitor", home) + "\n");
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
