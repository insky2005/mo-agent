import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CLAIM_ATTEMPTS = 5;
const CLAIM_RETRY_MS = 80;
const REQUEST_POLL_MS = 200;

type LockInfo = {
  pid: number;
  token: string;
  startedAt: number;
};

export type SingleInstanceOptions = {
  /** 单实例锁文件：内容是本进程的 PID 与随机 token。 */
  lockPath: string;
  /** 第二次启动时写入的请求文件；主实例轮询到它就打开监控屏。 */
  requestPath: string;
  /** 收到第二次启动请求时，在已经运行的实例里执行。 */
  onLaunch: () => void;
  log?: (message: string) => void;
};

export type SingleInstance = {
  /** true = 当前进程是主实例；false = 已有实例在运行（请求已写入，调用方应退出）。 */
  claim: () => Promise<boolean>;
  /** 退出前释放锁；只删除自己持有的锁，避免误删新实例的。 */
  release: () => void;
};

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在，只是没有发信号的权限。
    return (error as { code?: string } | null)?.code === "EPERM";
  }
}

/**
 * 用「硬链接原子创建锁文件 + 请求文件轮询」做单实例：
 * - 锁文件由 linkSync 原子创建，内容始终完整（不会读到半截 PID）；
 * - 锁里的 PID 已退出 = 上次崩溃遗留，清理后重试；
 * - 已有活实例 = 写一个请求文件后退出，由主实例轮询到并打开监控屏。
 *
 * 不用 Unix socket 是因为打包后的 cottontail 运行时会在 bind 前清掉同路径的
 * 旧 socket，第二次启动会「绑定成功」，反而绕过单实例锁。
 */
export function createSingleInstance(options: SingleInstanceOptions): SingleInstance {
  const log = options.log || (() => {});
  const token = randomUUID();
  let ownsLock = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function readLock(): LockInfo | null {
    try {
      const parsed = JSON.parse(readFileSync(options.lockPath, "utf8"));
      const pid = Number(parsed && parsed.pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return {
        pid,
        token: String(parsed.token || ""),
        startedAt: Number(parsed.startedAt) || 0,
      };
    } catch (error) {
      return null;
    }
  }

  function tryCreateLock(): boolean {
    const payload = JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }) + "\n";
    const temp = options.lockPath + ".tmp-" + process.pid + "-" + token;
    try {
      writeFileSync(temp, payload, { mode: 0o600 });
      // link 在同目录同文件系统上是原子的：要么成功，要么 EEXIST，
      // 不会出现「锁文件已建但 PID 还没写完」的窗口。
      linkSync(temp, options.lockPath);
      return true;
    } catch (error) {
      return false;
    } finally {
      try { unlinkSync(temp); } catch (error) { /* 临时文件可能没建出来 */ }
    }
  }

  function writeLaunchRequest(): void {
    try {
      mkdirSync(dirname(options.requestPath), { recursive: true });
      writeFileSync(options.requestPath, JSON.stringify({ requestedAt: Date.now(), pid: process.pid }) + "\n", { mode: 0o600 });
    } catch (error) {
      log("写入再次启动请求失败: " + error);
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (!existsSync(options.requestPath)) return;
      // 先删再处理：避免处理期间重复触发。
      try { unlinkSync(options.requestPath); } catch (error) { /* 已经被处理 */ }
      log("收到再次启动请求");
      options.onLaunch();
    }, REQUEST_POLL_MS);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  async function claim(): Promise<boolean> {
    try {
      mkdirSync(dirname(options.lockPath), { recursive: true });
    } catch (error) {
      log("创建单实例目录失败: " + error);
    }

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      if (tryCreateLock()) {
        ownsLock = true;
        // 上次崩溃前留下的请求不再有意义：启动本身就会打开监控屏。
        try { unlinkSync(options.requestPath); } catch (error) { /* 没有遗留请求 */ }
        startPolling();
        return true;
      }

      const info = readLock();
      if (info && processAlive(info.pid)) {
        log("已有实例在运行: pid=" + info.pid);
        writeLaunchRequest();
        return false;
      }

      // 锁文件在，但主人已经退出：清理后重试。
      try { unlinkSync(options.lockPath); } catch (error) { /* 已经被别人清理 */ }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_MS));
    }

    // 重试耗尽：仍然有活实例就当第二实例；否则宁可启动，也不要让 App 打不开。
    const info = readLock();
    if (info && processAlive(info.pid)) {
      log("已有实例在运行: pid=" + info.pid);
      writeLaunchRequest();
      return false;
    }
    log("单实例锁不可用，继续启动");
    return true;
  }

  function release(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (!ownsLock) return;
    ownsLock = false;
    const info = readLock();
    if (info && info.token === token) {
      try { unlinkSync(options.lockPath); } catch (error) { /* 已经被清理 */ }
    }
  }

  return { claim, release };
}
