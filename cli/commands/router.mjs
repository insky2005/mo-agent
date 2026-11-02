import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { daemonCommand } from "./daemon.mjs";
import { createRouterManager } from "../lib/router-manager.mjs";

/**
 * mo router —— 指挥台（Router）的开关、配置与运行时安装。
 *
 * 全部在本地完成：Router 的实现就是应用层（cli/lib/router-*），不需要常驻服务。
 * host 只负责"被看见 / 被远程说话"（注入 hub、手机与钉钉信道），不在也能起停。
 * pid 由启动者写，host 启动时用 adopt() 接管，不会重启它。
 */

const USAGE = "mo router start|stop|status|restart|setup|reset|runtime";

const localManagers = new Map();
function localRouter(dataDir) {
  const key = String(dataDir || "");
  if (!localManagers.has(key)) {
    localManagers.set(
      key,
      createRouterManager({ dataDir: dataDir || undefined, log: { info() {}, warn() {}, error() {} } }),
    );
  }
  return localManagers.get(key);
}

function sessionFile(home) {
  return path.join(home, ".mo-agent", "session.json");
}

/**
 * host 每次启动都会写 session.json（本机令牌 + 地址）。
 * 它有 url 也可能有 port，两种都得认——这里只用来判断"host 在不在"，给提示用。
 */
export function readHostSession(home) {
  try {
    const info = JSON.parse(fs.readFileSync(sessionFile(home), "utf8"));
    const token = typeof info.token === "string" ? info.token : null;
    let port = Number(info.port) || null;
    if (!port && typeof info.url === "string") {
      try {
        port = Number(new URL(info.url).port) || null;
      } catch {
        port = null;
      }
    }
    if (!port) return null;
    return { port, token, pid: Number(info.pid) || null };
  } catch {
    return null;
  }
}

/**
 * session.json 只能证明"曾经起过"——host 停了文件还在（踩过：
 * 旧 session 让 --start-daemon 以为 host 在跑，于是跳过了启动，接着 open 失败）。
 * 所以要看 pid 还活着没。
 */
export function hostAliveSync(session) {
  if (!session) return false;
  if (session.pid) {
    try {
      process.kill(session.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 真要确认能服务，还得探一下健康检查 */
async function hostHealthy(session) {
  if (!session) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const res = await fetch("http://127.0.0.1:" + session.port + "/api/health", { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 没有 host 就没有远程能力：说清楚，别让人以为手机连不上是坏了 */
function remoteHint(home) {
  if (hostAliveSync(readHostSession(home))) return "";
  return "\n  远程    现在没有 host：手机 / 钉钉 / 监控页都连不上。要这些能力就另开终端跑 mo daemon start";
}

/**
 * --start-daemon：先把 host 起来，再打开监控屏，然后才进 TUI。
 *
 * host 失败不阻断指挥台（它本地能跑），只丢远程能力——所以这里只提示，不抛错。
 */
async function ensureDaemon(ctx, home, args) {
  const quiet = !has(args.options, "verbose");
  const session = readHostSession(home);
  const alreadyRunning = await hostHealthy(session);
  if (!alreadyRunning) {
    process.stderr.write("启动 host…\n");
    try {
      await daemonCommand(
        { cwd: (ctx && ctx.cwd) || process.cwd(), env: (ctx && ctx.env) || process.env },
        { positional: ["start"], options: { "no-apk": true, quiet: true } },
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      process.stderr.write("host 没起来：" + message + "\n");
      process.stderr.write("  指挥台仍可本地运行，但手机 / 钉钉 / 监控页连不上\n");
      return { started: false, alreadyRunning: false, ready: false };
    }
  } else if (!quiet) {
    process.stderr.write("host 已在运行（不重复启动）\n");
  }

  // 起来之后再确认一次，别拿旧 session 去开页面
  const ready = readHostSession(home);
  if (!(await hostHealthy(ready))) {
    process.stderr.write("host 没有响应，跳过打开监控屏\n");
    return { started: false, alreadyRunning, ready: false };
  }

  if (!has(args.options, "no-open")) {
    try {
      await daemonCommand(
        { cwd: (ctx && ctx.cwd) || process.cwd(), env: (ctx && ctx.env) || process.env },
        { positional: ["open", "monitor"], options: {} },
      );
    } catch (error) {
      process.stderr.write("打开监控屏失败：" + (error && error.message ? error.message : error) + "\n");
    }
  }
  return { started: !alreadyRunning, alreadyRunning, ready: true };
}

/** 退出时提醒：host 是独立进程，不会跟着指挥台一起退 */
function daemonExitHint(home, daemonState) {
  if (!daemonState || !daemonState.ready) return "";
  if (!hostAliveSync(readHostSession(home))) return "";
  const line = daemonState.started
    ? "  host    还在跑（刚才是这条命令起的）：mo daemon stop 可停；留着它手机 / 监控仍可用"
    : "  host    还在跑：mo daemon stop 可停；留着它手机 / 监控仍可用";
  return "\n" + line;
}

function describe(status) {
  if (!status.running) {
    const lines = ["指挥台  未运行"];
    lines.push("  启动    mo router");
    if (!status.onboarded) lines.push("  首次    先 mo router runtime install，再 mo router setup");
    return lines.join("\n");
  }
  const lines = ["指挥台  运行中（pid " + status.pid + "）"];
  if (status.model) {
    const thinking = status.thinking ? "（思考 " + status.thinking + "）" : "";
    lines.push("  模型    " + (status.provider ? status.provider + " / " : "") + status.model + thinking);
  }
  if (status.runtime) lines.push("  运行时  " + status.runtime + " " + status.version);
  lines.push("  工作台  " + status.cwd);
  lines.push("  停止    mo router stop");
  return lines.join("\n");
}

async function runtimeCommand(manager, args) {
  const action = args.positional[1] || "list";

  if (action === "list") {
    const value = manager.runtimes();
    emit(args.options, value, (data) => {
      const lines = ["运行时  清单 pin 在 " + data.pinned + (data.inUse ? "，当前在用 " + data.inUse : "")];
      if (!data.runtimes.length) lines.push("  还没装：mo router runtime install");
      for (const item of data.runtimes) {
        lines.push("  " + (item.version === data.inUse ? "*" : " ") + " " + item.version + (item.installed ? "" : "（文件缺失）"));
      }
      return lines.join("\n");
    });
    return 0;
  }

  if (action === "install") {
    const version = one(args.options, "version");
    const force = has(args.options, "force");
    process.stderr.write("安装运行时" + (version ? " " + version : "") + "…（首次会下载约 150MB 依赖）\n");
    const value = await manager.runtimeInstall({ version: version || undefined, force });
    emit(args.options, value, (data) =>
      data.reused
        ? "✓ 运行时已存在（" + data.version + "），沿用 " + data.dir
        : "✓ 运行时已安装（" + data.version + "）\n  " + data.dir + "\n  Node " + (data.nodeVersion || data.node),
    );
    return 0;
  }

  if (action === "prune") {
    const value = manager.runtimePrune();
    emit(args.options, value, (data) =>
      data.removed.length
        ? "✓ 已删除旧版本：" + data.removed.join(" / ") + "\n  保留：" + data.kept.join(" / ")
        : "没有需要清理的旧版本（保留：" + data.kept.join(" / ") + "）",
    );
    return 0;
  }

  throw new MoError("E_USAGE", "未知子命令：router runtime " + action, {
    hint: "mo router runtime install|list|prune",
  });
}

export async function routerCommand(ctx, args) {
  const sub = args.positional[0] || "start";
  const home = (ctx && ctx.home) || os.homedir();
  const manager = localRouter(ctx && ctx.dataDir);

  if (sub === "runtime") return runtimeCommand(manager, args);

  if (sub === "setup") {
    const provider = one(args.options, "provider");
    const model = one(args.options, "model");
    const apiKey = one(args.options, "key");
    const test = !has(args.options, "no-test");
    if (!provider && !apiKey) {
      throw new MoError("E_USAGE", "setup 需要 --provider 与 --key", {
        hint: "mo router setup --provider deepseek --model deepseek-flash --key sk-...",
      });
    }
    const value = await manager.setup({ provider, model, apiKey, test });
    emit(args.options, value, (data) => {
      const lines = ["✓ 指挥台已配置"];
      lines.push("  模型    " + data.provider + " / " + data.model + (data.thinking ? "（思考 " + data.thinking + "）" : ""));
      lines.push("  凭据    " + data.redacted + "（" + data.source + "）");
      if (data.test && data.test.tested) {
        lines.push(data.test.ok ? "  测通    ✓ " + data.test.ms + "ms" : "  测通    ✗ " + data.test.error);
      } else if (data.test && data.test.reason) {
        lines.push("  测通    " + data.test.reason);
      }
      return lines.join("\n");
    });
    return 0;
  }

  if (sub === "reset") {
    const value = manager.reset();
    emit(args.options, value, (data) => (data.removed ? "✓ 已删除 Router 的凭据" : "本来就没有凭据"));
    return 0;
  }

  if (sub === "start") {
    // 默认就地跑：在终端里敲 mo router，本来就是"我要在这儿用它"。
    // 要后台/开窗口用 --window；非 TTY（脚本、CI）仍走窗口，否则会挂住调用方。
    const wantsWindow = has(args.options, "window") || has(args.options, "detach");
    const wantsForeground = has(args.options, "foreground") || has(args.options, "f");
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const foreground = !wantsWindow && (wantsForeground || tty);

    // 先 host（+ 监控屏），再进 TUI：这样界面一起就能在网页上看到它
    let daemonState = null;
    if (has(args.options, "start-daemon") || has(args.options, "with-daemon")) {
      daemonState = await ensureDaemon(ctx, home, args);
    }

    if (foreground) {
      process.stderr.write("指挥台在当前终端运行，Ctrl-C 停止" + (hostAliveSync(readHostSession(home)) ? "" : "（没有 host：远程控制暂不可用）") + "\n");
      const value = await manager.start({ foreground: true });
      if (value && value.attached) {
        // 已经有一个在跑（可能在别的终端/窗口）：单实例，不抢也不重复起
        emit(
          args.options,
          value,
          (data) =>
            "指挥台已经在运行（pid " + data.pid + "），当前终端不接管。\n" +
            "  想在这个终端跑：先 mo router stop，再 mo router",
        );
        return 0;
      }
      emit(args.options, value, (data) => {
        const head = "指挥台已退出（退出码 " + (data.exitCode === undefined ? "?" : data.exitCode) + "）";
        return head + daemonExitHint(home, daemonState);
      });
      return 0;
    }

    const value = await manager.start();
    emit(args.options, value, (data) => {
      if (data.attached) return "指挥台已在运行（pid " + data.pid + "），没有重复启动";
      const head = "✓ 指挥台已启动（pid " + data.pid + "）";
      const warnings = Array.isArray(data.warnings) && data.warnings.length ? "\n  " + data.warnings.join("\n  ") : "";
      return head + warnings + "\n  工作台  " + data.cwd + remoteHint(home);
    });
    return 0;
  }

  if (sub === "stop") {
    const value = manager.stop();
    emit(args.options, value, (data) => (data.stopped ? "✓ 指挥台已停止（pid " + data.pid + "）" : "指挥台本来就没在运行"));
    return 0;
  }

  if (sub === "status") {
    const value = manager.status();
    emit(args.options, value, (data) => describe(data) + (data.running ? "" : remoteHint(home)));
    return value.running ? 0 : 1;
  }

  if (sub === "restart") {
    manager.stop();
    const value = await manager.start();
    emit(args.options, value, (data) => "✓ 指挥台已重启（pid " + data.pid + "）" + remoteHint(home));
    return 0;
  }

  throw new MoError("E_USAGE", "未知子命令：router " + sub + "（" + USAGE + "）", { hint: USAGE });
}
