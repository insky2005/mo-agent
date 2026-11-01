import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MoError } from "../../core/errors.mjs";
import { EVENT, SESSION_ROLE } from "../../core/contract.mjs";
import { renderRouterContract } from "../../core/manager/contract.mjs";
import {
  ROUTER_AGENT_LABEL,
  ROUTER_ERROR,
  ROUTER_SESSION_ID,
  ROUTER_SESSION_NAME,
  admitRuntime,
} from "../../core/router.mjs";
import { buildPiArgv } from "./argv.mjs";
import { resolveCredentials } from "./credentials.mjs";
import { openTerminal } from "./terminal.mjs";
import { renderRouterScript } from "./script.mjs";
import { readJsonSafe, writeFilePrivate, writeJsonPrivate } from "./fsx.mjs";
import * as P from "./paths.mjs";

/** Pi 作为 Router 时声明给准入检查的能力（见 core/router.mjs） */
export const PI_ROUTER_CAPABILITIES = Object.freeze({
  toolRestriction: "allowlist",
  control: ["prompt", "cancel"],
  prompt: true,
  cancel: true,
  ui: "tui",
});

const WORKBENCH_README = [
  "# 指挥所",
  "",
  "这里是 mo 的指挥台（Router）的工作目录，**不是项目**。",
  "",
  "它属于 Router 的对话，不属于任何代码仓库；不要在这里构建、测试或改代码。",
  "要动某个项目，请让 Router 建卡派单，执行者在项目自己的目录里干活。",
  "",
  "由 mo 自动生成，可安全删除（下次启动会重建）。",
  "",
].join("\n");

function isAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(file) {
  try {
    const value = Number(String(fs.readFileSync(file, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** 运行时解析：env 覆盖（开发/测试） > 私有目录里版本号最大的那个 */
export function resolveRuntime(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const home = opts.home;

  if (env.MO_ROUTER_RUNTIME_BIN) {
    return {
      id: "pi",
      bin: path.resolve(env.MO_ROUTER_RUNTIME_BIN),
      version: String(env.MO_ROUTER_RUNTIME_VERSION || "0.0.0"),
      source: "env",
      capabilities: PI_ROUTER_CAPABILITIES,
    };
  }

  const base = path.join(P.runtimeRoot({ home, env, platform: opts.platform }), "routers", "pi");
  let versions = [];
  try {
    versions = fs.readdirSync(base).sort().reverse();
  } catch {
    return null;
  }
  for (const version of versions) {
    const bin = path.join(base, version, "bin", "pi");
    if (fs.existsSync(bin)) {
      return { id: "pi", bin, version, source: "private", capabilities: PI_ROUTER_CAPABILITIES };
    }
  }
  return null;
}

function waitForPid(file, timeoutMs, now) {
  const deadline = now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const pid = readPidFile(file);
      if (pid) return resolve(pid);
      if (now() >= deadline) return resolve(null);
      setTimeout(tick, 40);
    };
    tick();
  });
}

/**
 * Router 的生命周期归 host（实现计划 §6 R2）：CLI 只发 HTTP 请求。
 * 这个工厂只做三件事：改文件、起进程、把会话注入 hub。
 */
export function createRouterManager(options) {
  const opts = options || {};
  const home = opts.home;
  const hub = opts.hub;
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const now = opts.now || Date.now;
  const spawnImpl = opts.spawn || spawn;
  const openTerminalImpl = opts.openTerminal || openTerminal;

  if (!home) throw new Error("createRouterManager 需要 home");
  if (!hub) throw new Error("createRouterManager 需要 hub");

  const files = {
    root: P.routerRoot(home),
    state: P.routerFile(home),
    pid: P.routerPidFile(home),
    log: P.routerLogFile(home),
    script: P.startScriptFile(home),
    credentials: P.credentialsFile(home),
    config: P.configDir(home),
    sessions: P.sessionsDir(home),
    workbench: P.workbenchDir(home),
    contract: P.contractFile(home),
    readme: P.workbenchReadme(home),
    extension: P.extensionFile(home),
    mcp: P.mcpConfigFile(home),
  };

  function readState() {
    const value = readJsonSafe(files.state, null);
    return value && typeof value === "object" ? value : null;
  }

  function emitSession(patch) {
    hub.emit(EVENT.SESSION_UPSERT, {
      id: ROUTER_SESSION_ID,
      sessionId: ROUTER_SESSION_ID,
      role: SESSION_ROLE.ROUTER,
      agent: "pi",
      agentLabel: ROUTER_AGENT_LABEL,
      title: ROUTER_SESSION_NAME,
      cwd: files.workbench,
      status: "running",
      running: true,
      capabilities: { control: ["prompt", "cancel"], prompt: true, cancel: true },
      updatedAt: now(),
      ...patch,
    });
  }

  function status() {
    const state = readState() || {};
    const pid = readPidFile(files.pid) || (state.pid ? Number(state.pid) : null);
    const running = isAlive(pid);
    const session = hub.get(ROUTER_SESSION_ID);
    return {
      ok: true,
      running,
      pid: running ? pid : null,
      onboarded: Boolean(state.onboarded),
      runtime: state.runtime || null,
      version: state.version || null,
      provider: state.provider || null,
      model: state.model || null,
      source: state.source || null,
      sessionId: ROUTER_SESSION_ID,
      cwd: files.workbench,
      inHub: Boolean(session),
      role: session ? session.role : null,
    };
  }

  /**
   * mo 的 MCP 服务只注册进 Router 的私有配置目录。
   * 格式与 `pi mcp add` 一致（已实测）：{"mcpServers":{"mo":{"command","args"}}}。
   * 工具名在 Pi 侧是 mcp__mo__<tool>，正是白名单里的 mcp__mo__*。
   */
  function writeMcpConfig() {
    const command = String(env.MO_ROUTER_MO_BIN || "mo");
    writeJsonPrivate(files.mcp, { mcpServers: { mo: { command, args: ["mcp"] } } }, 0o600);
  }

  function ensureAssets(runtime) {
    fs.mkdirSync(files.config, { recursive: true });
    fs.mkdirSync(files.sessions, { recursive: true });
    fs.mkdirSync(files.workbench, { recursive: true });
    writeFilePrivate(files.contract, renderRouterContract(), 0o600);
    writeFilePrivate(files.readme, WORKBENCH_README, 0o644);
    writeMcpConfig();
    return runtime;
  }

  async function start() {
    const current = status();
    if (current.running) {
      log.info("Router 已在运行（pid " + current.pid + "），attach");
      return { ...current, attached: true };
    }

    const runtime = resolveRuntime({ home, env, platform });
    if (!runtime) {
      throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "找不到 Router 运行时", {
        hint: "先 mo router runtime install，或用 MO_ROUTER_RUNTIME_BIN 指向一个开发版本",
      });
    }
    const admitted = admitRuntime(runtime.capabilities);
    if (!admitted.ok) {
      throw new MoError(ROUTER_ERROR.RUNTIME_UNSUPPORTED, admitted.reason, { code: admitted.code });
    }

    const credentials = resolveCredentials(home, env);
    if (!credentials.ok) {
      throw new MoError(credentials.code, credentials.reason, { provider: credentials.provider });
    }

    ensureAssets(runtime);

    const extensionPath = fs.existsSync(files.extension) ? files.extension : null;
    const argv = buildPiArgv({
      runtimeBin: runtime.bin,
      cwd: files.workbench,
      contractPath: files.contract,
      agentDir: files.config,
      sessionDir: files.sessions,
      extensionPath,
      offline: true,
    });

    const headless = String(env.MO_ROUTER_HEADLESS || "") === "1";
    const script = renderRouterScript({
      bin: argv.command,
      args: argv.args,
      cwd: argv.cwd,
      env: { ...argv.env, ...credentials.env },
      pidFile: files.pid,
      logFile: headless ? files.log : null,
    });
    writeFilePrivate(files.script, script, 0o700);
    try {
      fs.rmSync(files.pid, { force: true });
    } catch {
      // 旧 pid 文件清不掉不影响启动
    }

    const warnings = [];
    let launched = null;
    if (headless) {
      const child = spawnImpl("/bin/sh", [files.script], { detached: true, stdio: "ignore", env: process.env });
      if (child && typeof child.unref === "function") child.unref();
      launched = { launched: true, kind: "headless", command: "/bin/sh" };
    } else {
      launched = openTerminalImpl({ scriptPath: files.script, platform });
      if (!launched.launched) {
        warnings.push("没有打开终端窗口（" + (launched.reason || "未知原因") + "），回落为后台启动");
        const child = spawnImpl("/bin/sh", [files.script], { detached: true, stdio: "ignore", env: process.env });
        if (child && typeof child.unref === "function") child.unref();
      }
    }
    if (admitted.note) warnings.push(admitted.note);

    const pid = await waitForPid(files.pid, 5000, now);
    if (!pid) {
      throw new MoError(ROUTER_ERROR.START_FAILED, "Router 没有按预期启动（没拿到 pid）", {
        hint: "看 " + files.script + (headless ? " 与 " + files.log : ""),
      });
    }

    const state = {
      v: 1,
      onboarded: true,
      runtime: runtime.id,
      version: runtime.version,
      source: runtime.source,
      provider: credentials.provider,
      model: credentials.model,
      sessionId: ROUTER_SESSION_ID,
      pid,
      cwd: files.workbench,
      startedAt: new Date(now()).toISOString(),
    };
    writeJsonPrivate(files.state, state);

    emitSession({ pid });
    log.info("Router 已启动（pid " + pid + "，runtime " + runtime.id + " " + runtime.version + "）");
    return { ...status(), attached: false, launched, warnings, script: files.script };
  }

  function stop() {
    const pid = readPidFile(files.pid);
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // 已经退出
      }
      const deadline = now() + 5000;
      while (Date.now() < deadline && isAlive(pid)) {
        // 同步等待：这段最长 5 秒，和 daemon stop 一致
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        sleepSync(100);
      }
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 忽略
        }
      }
    }
    try {
      fs.rmSync(files.pid, { force: true });
    } catch {
      // 忽略
    }
    const state = readState();
    if (state) writeJsonPrivate(files.state, { ...state, pid: null, stoppedAt: new Date(now()).toISOString() });
    hub.emit(EVENT.SESSION_REMOVED, { sessionId: ROUTER_SESSION_ID, id: ROUTER_SESSION_ID });
    return { ok: true, stopped: Boolean(pid), pid: pid || null };
  }

  return { status, start, stop, files, resolveRuntime };
}

function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}
