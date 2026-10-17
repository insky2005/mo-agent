import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const DEFAULT_INFO = path.join(os.homedir(), ".mo-agent", "voice-bridge.json");

/**
 * 常驻语音 helper 的客户端。
 *
 * helper 由 open 启动一次，之后 host 通过 127.0.0.1 上的一行 JSON 协议
 * 发 ping / selftest / record / quit，不再每次录音都写临时文件。
 */
export function createHelperClient(options) {
  const opts = options || {};
  const app = opts.app;
  const infoPath = opts.infoPath || DEFAULT_INFO;
  const log = opts.log || function () {};
  const launch = opts.launch || function (bundle) {
    return execFileP("open", ["-n", bundle], { timeout: 10000 });
  };
  const appBundle = app ? app.replace(/\/Contents\/MacOS\/.*$/, "") : "";

  async function readInfo() {
    try {
      return JSON.parse(await fs.readFile(infoPath, "utf8"));
    } catch (error) {
      return null;
    }
  }

  function pidAlive(pid) {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  function request(info, payload, timeoutMs) {
    return new Promise(function (resolve) {
      let settled = false;
      let buffer = "";
      let timer = null;
      const socket = net.connect({ host: "127.0.0.1", port: info.port });

      function done(value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { socket.destroy(); } catch (error) { /* 忽略 */ }
        resolve(value);
      }

      timer = setTimeout(function () { done({ ok: false, error: "timeout" }); }, timeoutMs);

      socket.on("connect", function () {
        socket.write(JSON.stringify(Object.assign({ token: info.token }, payload)) + "\n");
      });
      socket.on("data", function (chunk) {
        buffer += chunk.toString();
        const index = buffer.indexOf("\n");
        if (index === -1) return;
        try {
          done(JSON.parse(buffer.slice(0, index)));
        } catch (error) {
          done({ ok: false, error: "bad-response" });
        }
      });
      socket.on("error", function (error) {
        done({ ok: false, error: "connect-failed", message: String(error && error.message ? error.message : error) });
      });
      socket.on("close", function () {
        if (!settled) done({ ok: false, error: "closed" });
      });
    });
  }

  async function ping(info) {
    return request(info, { cmd: "ping" }, 800);
  }

  async function ensure() {
    let info = await readInfo();
    if (info && info.port && pidAlive(info.pid)) {
      const pong = await ping(info);
      if (pong && pong.ok) return info;
    }

    // 残留的 info（进程已死/端口不通）先删掉，避免新 helper 以为已有实例。
    if (info) await fs.unlink(infoPath).catch(function () {});
    if (!appBundle) return null;

    try {
      await launch(appBundle);
    } catch (error) {
      log({ type: "helper-launch-failed", message: String(error && error.message ? error.message : error) });
      return null;
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
      info = await readInfo();
      if (!info) continue;
      if (!pidAlive(info.pid)) continue;
      const pong = await ping(info);
      if (pong && pong.ok) return info;
    }
    return null;
  }

  let keepaliveTimer = null;

  return {
    async keepalive(intervalMs) {
      if (keepaliveTimer) return;
      keepaliveTimer = setInterval(async function () {
        const info = await readInfo();
        if (info && info.port && pidAlive(info.pid)) await ping(info);
      }, intervalMs || 60000);
      if (typeof keepaliveTimer.unref === "function") keepaliveTimer.unref();
    },

    async selftest() {
      const info = await ensure();
      if (!info) return { ok: false, error: "helper-unavailable" };
      return request(info, { cmd: "selftest" }, 5000);
    },

    async record(input) {
      const info = await ensure();
      if (!info) return { ok: false, error: "helper-unavailable" };
      const seconds = Math.max(1, Math.ceil(((input && input.timeoutMs) || 15000) / 1000));
      const result = await request(info, {
        cmd: "record",
        timeout: seconds,
        silence: (input && input.silence) || 1.1,
        max: (input && input.maxSeconds) || 12,
        threshold: (input && input.threshold) || 0.008,
      }, seconds * 1000 + 75000);
      return result;
    },

    async shutdown() {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      const info = await readInfo();
      if (!info || !info.port) return;
      await request(info, { cmd: "quit" }, 1000);
    },
  };
}
