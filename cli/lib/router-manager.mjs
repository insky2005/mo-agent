import fs from "node:fs";
import os from "node:os";
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
import { buildPiArgv } from "./router-argv.mjs";
import { deleteCredentials, redactSecret, resolveCredentials, writeCredentials } from "./router-credentials.mjs";
import { probeModel } from "./router-probe.mjs";
import { installRuntime, listRuntimes, manifestFor, pruneRuntimes, repairShim } from "./router-install.mjs";
import { openTerminal } from "./router-terminal.mjs";
import { renderRouterScript, renderRouterSecrets } from "./router-script.mjs";
import { readJsonSafe, writeFilePrivate, writeJsonPrivate } from "./fsx.mjs";
import * as P from "./router-paths.mjs";

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

/** Router 会话在 hub 里的形状：host 注入与会话接管共用，避免两处各写一份 */
export function routerSessionPayload(patch) {
  return {
    id: ROUTER_SESSION_ID,
    sessionId: ROUTER_SESSION_ID,
    role: SESSION_ROLE.ROUTER,
    agent: "pi",
    agentLabel: ROUTER_AGENT_LABEL,
    title: ROUTER_SESSION_NAME,
    status: "running",
    running: true,
    capabilities: { control: ["prompt", "cancel"], prompt: true, cancel: true },
    ...patch,
  };
}

/**
 * Router 的生命周期：谁启动谁持有 pid；host 只做"接管控制面"。
 * 这个工厂只做三件事：改文件、起进程、把会话通知出去。
 *
 * hub 是可选的：host 传它（会话直接进 hub）；CLI 不传（本地起，等 host 启动时 adopt）。
 */
export function createRouterManager(options) {
  const opts = options || {};
  const hub = opts.hub || null;
  const onSession = typeof opts.onSession === "function" ? opts.onSession : null;
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const now = opts.now || Date.now;
  const spawnImpl = opts.spawn || spawn;
  const openTerminalImpl = opts.openTerminal || openTerminal;
  const probe = opts.probe || probeModel;

  // dataDir：mo 的数据目录（跟人走）；osHome：只用来推程序产物路径
  const dataDir = opts.dataDir || P.moDataDir(env);
  const osHome = opts.osHome || os.homedir();

  const files = {
    root: P.routerRoot(dataDir),
    state: P.routerFile(dataDir),
    pid: P.routerPidFile(dataDir),
    log: P.routerLogFile(dataDir),
    script: P.startScriptFile(dataDir),
    secrets: P.secretsFile(dataDir),
    credentials: P.credentialsFile(dataDir),
    config: P.configDir(dataDir),
    sessions: P.sessionsDir(dataDir),
    workbench: P.workbenchDir(dataDir),
    contract: P.contractFile(dataDir),
    readme: P.workbenchReadme(dataDir),
    extension: P.extensionFile(dataDir),
    mcp: P.mcpConfigFile(dataDir),
  };

  function readState() {
    const value = readJsonSafe(files.state, null);
    return value && typeof value === "object" ? value : null;
  }

  /** 会话通知：onSession 回调（CLI 自用）+ hub（host 用），两者都可以为空 */
  function notifySession(kind, payload) {
    if (onSession) onSession(kind, payload);
    if (hub) hub.emit(kind === "upsert" ? EVENT.SESSION_UPSERT : EVENT.SESSION_REMOVED, payload);
  }

  function emitSession(patch) {
    notifySession(
      "upsert",
      routerSessionPayload({ cwd: files.workbench, updatedAt: now(), ...patch }),
    );
  }

  /**
   * 进程已经没了、但 pid / 密钥文件还留着（被 kill -9、关窗口、崩溃）：
   * 顺手清掉。密钥投影不该在指挥台不运行时还躺在磁盘上。
   */
  /** 只清密钥投影（并发冲突时别动别人的 pid） */
  function cleanStaleSecretsOnly() {
    try {
      fs.rmSync(files.secrets, { force: true });
    } catch {
      // 忽略
    }
  }

  function cleanStaleFiles() {
    for (const file of [files.pid, files.secrets]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 删不掉不影响状态判断
      }
    }
  }

  function status() {
    const state = readState() || {};
    const pid = readPidFile(files.pid) || (state.pid ? Number(state.pid) : null);
    const running = isAlive(pid);
    if (!running && pid) cleanStaleFiles();
    const session = hub ? hub.get(ROUTER_SESSION_ID) : null;
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

  /**
   * 把 mo 的控制扩展复制进私有配置目录。
   * 复制而不是引用用户全局的 ~/.pi/agent/extensions：Router 的扩展必须与它自己的
   * 版本绑在一起，用户改自己的 Pi 不该影响 Router 的控制通道。
   */
  function ensureExtension() {
    const source = new URL("../../integrations/pi/mo-agent-control.js", import.meta.url);
    const sourceImpl = new URL("../../integrations/pi/mo-agent-control-impl.js", import.meta.url);
    try {
      if (!fs.existsSync(source)) return false;
      fs.mkdirSync(path.dirname(files.extension), { recursive: true });
      fs.copyFileSync(source, files.extension);
      if (fs.existsSync(sourceImpl)) {
        fs.copyFileSync(sourceImpl, path.join(path.dirname(files.extension), "mo-agent-control-impl.js"));
      }
      return true;
    } catch (error) {
      log.warn("复制控制扩展失败（手机/钉钉将无法给指挥台发指令）: " + (error && error.message ? error.message : error));
      return false;
    }
  }

  function ensureAssets(runtime) {
    fs.mkdirSync(files.config, { recursive: true });
    fs.mkdirSync(files.sessions, { recursive: true });
    fs.mkdirSync(files.workbench, { recursive: true });
    writeFilePrivate(files.contract, renderRouterContract(), 0o600);
    writeFilePrivate(files.readme, WORKBENCH_README, 0o644);
    writeMcpConfig();
    ensureExtension();
    return runtime;
  }

  async function start(startOptions) {
    const runOpts = startOptions || {};
    const current = status();
    if (current.running) {
      log.info("Router 已在运行（pid " + current.pid + "），attach");
      return { ...current, attached: true };
    }

    const runtime = resolveRuntime({ home: osHome, env, platform });
    if (!runtime) {
      throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "找不到 Router 运行时", {
        hint: "先 mo router runtime install，或用 MO_ROUTER_RUNTIME_BIN 指向一个开发版本",
      });
    }
    // 启动前顺手修一次启动器：旧版本可能把裸 "node" 写进 shim（等于没钉 Node）
    if (runtime.source === "private") {
      const installed = path.dirname(path.dirname(runtime.bin));
      try {
        const repair = repairShim({ target: installed, env, manifest: manifestFor("pi") });
        if (repair.changed) log.info("已修复运行时启动器（Node 固定为 " + repair.node + "）");
      } catch (error) {
        log.warn("修启动器失败（不影响启动）: " + (error && error.message ? error.message : error));
      }
    }

    const admitted = admitRuntime(runtime.capabilities);
    if (!admitted.ok) {
      throw new MoError(ROUTER_ERROR.RUNTIME_UNSUPPORTED, admitted.reason, { code: admitted.code });
    }

    const credentials = resolveCredentials(dataDir, env);
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
      provider: credentials.provider,
      model: credentials.model,
    });

    const headless = String(env.MO_ROUTER_HEADLESS || "") === "1";
    const foreground = Boolean(runOpts.foreground || opts.foreground);

    // 密钥单独一个文件（0600），启动脚本本身不再含任何凭据
    writeFilePrivate(
      files.secrets,
      renderRouterSecrets({ env: { ...argv.env, ...credentials.env } }),
      0o600,
    );
    const script = renderRouterScript({
      bin: argv.command,
      args: argv.args,
      cwd: argv.cwd,
      secretsFile: files.secrets,
      pidFile: files.pid,
      logFile: headless ? files.log : null,
    });
    writeFilePrivate(files.script, script, 0o644);
    try {
      fs.rmSync(files.pid, { force: true });
    } catch {
      // 旧 pid 文件清不掉不影响启动
    }

    const warnings = [];
    let launched = null;
    let foregroundChild = null;
    let detachedChild = null;
    if (headless) {
      const child = spawnImpl("/bin/sh", [files.script], { detached: true, stdio: "ignore", env: process.env });
      detachedChild = child;
      if (child && typeof child.unref === "function") child.unref();
      launched = { launched: true, kind: "headless", command: "/bin/sh" };
    } else if (foreground) {
      // 就地跑：继承当前终端，Ctrl-C 即停，不再开新窗口
      foregroundChild = spawnImpl("/bin/sh", [files.script], { stdio: "inherit", env: process.env });
      launched = { launched: true, kind: "foreground", command: "/bin/sh" };
    } else {
      launched = openTerminalImpl({ scriptPath: files.script, platform });
      if (!launched.launched) {
        warnings.push("没有打开终端窗口（" + (launched.reason || "未知原因") + "），回落为后台启动");
        const child = spawnImpl("/bin/sh", [files.script], { detached: true, stdio: "ignore", env: process.env });
        detachedChild = child;
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

    // 并发保护：两个 mo 同时 start 时，后写 pid 的赢。
    // 我们起的是 sh，它第一行就写自己的 pid，所以 pid 应当等于我们的子进程；
    // 对不上说明另一个实例抢先登记了 —— 把自己起的收掉，转为 attach，别留孤儿进程。
    const mine = (foregroundChild && foregroundChild.pid) || (detachedChild && detachedChild.pid) || null;
    if (mine && pid !== mine) {
      try {
        process.kill(mine, "SIGTERM");
      } catch {
        // 已经退出
      }
      cleanStaleSecretsOnly();
      const current = status();
      return { ...current, attached: true, conflict: true };
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

    // 前台模式：等它退出（Ctrl-C），退出后按"已停止"收尾
    if (foregroundChild) {
      const exitCode = await new Promise((resolve) => {
        foregroundChild.on("close", (code) => resolve(code === null ? 0 : code));
        foregroundChild.on("error", () => resolve(1));
      });
      cleanupAfterExit();
      return { ...status(), attached: false, launched, warnings, script: files.script, foreground: true, exitCode };
    }

    return { ...status(), attached: false, launched, warnings, script: files.script };
  }

  /** 进程退出后的收尾：删 pid 与密钥投影，通知会话消失 */
  function cleanupAfterExit() {
    for (const file of [files.pid, files.secrets]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 删不掉不影响退出
      }
    }
    const state = readState();
    if (state) writeJsonPrivate(files.state, { ...state, pid: null, stoppedAt: new Date(now()).toISOString() });
    notifySession("removed", { sessionId: ROUTER_SESSION_ID, id: ROUTER_SESSION_ID });
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
    // pid 与密钥投影都清掉：密钥文件只在运行期间存在
    for (const file of [files.pid, files.secrets]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 忽略
      }
    }
    const state = readState();
    if (state) writeJsonPrivate(files.state, { ...state, pid: null, stoppedAt: new Date(now()).toISOString() });
    notifySession("removed", { sessionId: ROUTER_SESSION_ID, id: ROUTER_SESSION_ID });
    return { ok: true, stopped: Boolean(pid), pid: pid || null };
  }

  /**
   * 引导：写凭据（0600）→ 可选测通 → 标记 onboarded。
   * 不启动 Router；启动是另一个动作，失败原因要能分开看。
   */
  async function setup(input) {
    const value = input || {};
    if (value.apiKey) writeCredentials(dataDir, value);

    const credentials = resolveCredentials(dataDir, env);
    if (!credentials.ok) {
      throw new MoError(credentials.code, credentials.reason + "（用 mo router setup --provider … --key … 配置）", {
        provider: credentials.provider,
      });
    }

    let test = { tested: false, reason: "已跳过测通" };
    if (value.test !== false) {
      const runtime = resolveRuntime({ home: osHome, env, platform });
      if (!runtime) {
        test = { tested: false, reason: "运行时还没安装，先 mo router runtime install 再测通" };
      } else {
        const result = await probe({
          bin: runtime.bin,
          provider: credentials.provider,
          model: credentials.model,
          env: credentials.env,
          timeoutMs: value.timeoutMs,
        });
        test = { tested: true, ok: result.ok, ms: result.ms, text: result.text || null, error: result.error || null };
        if (!result.ok) {
          throw new MoError(ROUTER_ERROR.START_FAILED, "测通失败：" + (result.error || "未知原因"), {
            hint: "检查 provider / 模型名 / key；也可以先 mo router setup --no-test 跳过",
            detail: test,
          });
        }
      }
    }

    const state = readState() || {};
    writeJsonPrivate(files.state, {
      ...state,
      v: 1,
      onboarded: true,
      runtime: state.runtime || "pi",
      version: state.version || null,
      provider: credentials.provider,
      model: credentials.model,
      configuredAt: new Date(now()).toISOString(),
    });

    log.info("指挥台配置完成：provider=" + credentials.provider + " model=" + credentials.model + " key=" + redactSecret(credentials.apiKey));
    return {
      ok: true,
      provider: credentials.provider,
      model: credentials.model,
      redacted: redactSecret(credentials.apiKey),
      source: credentials.source,
      test,
    };
  }

  function reset() {
    const removed = deleteCredentials(dataDir);
    const state = readState();
    if (state) writeJsonPrivate(files.state, { ...state, onboarded: false });
    return { ok: true, removed };
  }

  /** 运行时安装：耗时操作，HTTP 层会等它跑完（首次约 1–3 分钟） */
  function runtimeInstall(input) {
    const value = input || {};
    return installRuntime({
      home: osHome,
      env,
      log,
      platform,
      version: value.version,
      force: Boolean(value.force),
    });
  }

  function runtimes() {
    const manifest = manifestFor("pi");
    const state = readState() || {};
    return {
      ok: true,
      pinned: manifest.version,
      inUse: state.version || null,
      ...listRuntimes({ home: osHome, env, platform }),
    };
  }

  function runtimePrune() {
    const manifest = manifestFor("pi");
    const state = readState() || {};
    const keep = [manifest.version, state.version].filter(Boolean);
    return { ok: true, ...pruneRuntimes({ home: osHome, env, platform, keep }) };
  }

  return { status, start, stop, setup, reset, runtimeInstall, runtimes, runtimePrune, files, resolveRuntime };
}

function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}
