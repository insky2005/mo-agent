import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { has, one } from "../lib/args.mjs";
import { emit } from "../lib/output.mjs";
import { daemonCommand } from "./daemon.mjs";

/**
 * mo router —— 指挥台（Router）的开关、配置与运行时安装。
 *
 * 生命周期与安装都归 host（实现计划 §6 R2）：这里只发本机 HTTP 请求，不自己 spawn 进程，
 * 否则 CLI 与桌面 App 会各起一个，pid 文件互相覆盖。
 */

const USAGE = "mo router start|stop|status|restart|setup|reset|runtime";

function sessionFile(home) {
  return path.join(home, ".mo-agent", "session.json");
}

/** host 每次启动都会写 session.json（端口 + 本机令牌） */
export function readHostSession(home) {
  try {
    const info = JSON.parse(fs.readFileSync(sessionFile(home), "utf8"));
    const port = Number(info.port) || null;
    const token = typeof info.token === "string" ? info.token : null;
    if (!port) return null;
    return { port, token };
  } catch {
    return null;
  }
}

/** 需要 host 的动作可以自动把它拉起来；MO_AGENT_NO_AUTOSTART=1 可关 */
async function ensureHost(ctx) {
  if (String(process.env.MO_AGENT_NO_AUTOSTART || "") === "1") return false;
  if (ctx && ctx.autoStart === false) return false;
  process.stderr.write("host 没在运行，正在拉起…\n");
  try {
    const code = await daemonCommand(
      { cwd: (ctx && ctx.cwd) || process.cwd(), env: process.env },
      // 不要 APK：那是"手机装 App"的事，跟指挥台无关，30MB 白下
      { positional: ["start"], options: { "no-apk": true } },
    );
    return code === 0;
  } catch (error) {
    process.stderr.write("拉起 host 失败：" + (error && error.message ? error.message : error) + "\n");
    return false;
  }
}

/**
 * @param {{autoStart?: boolean, cwd?: string}} options
 *   autoStart: 连不上就顺手把 host 拉起来（只给"需要 host 才能做"的动作开）
 */
async function callRouter(home, pathname, method, body, options) {
  const opts = options || {};
  let session = readHostSession(home);
  if (!session && opts.autoStart) {
    await ensureHost(opts);
    session = readHostSession(home);
  }
  if (!session) {
    throw new MoError("E_DAEMON_DOWN", "mo daemon 没在运行（没有 session.json）", {
      hint: "先 mo daemon start，或打开桌面 App",
    });
  }
  const url = "http://127.0.0.1:" + session.port + pathname;
  const headers = {};
  if (session.token) headers["x-mo-agent-token"] = session.token;
  const init = { method: method || "GET", headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (opts.autoStart) {
      await ensureHost(opts);
      const retry = readHostSession(home);
      if (retry) {
        try {
          response = await fetch("http://127.0.0.1:" + retry.port + pathname, { ...init, headers: retry.token ? { ...headers, "x-mo-agent-token": retry.token } : headers });
        } catch (retryError) {
          response = null;
        }
      }
    }
    if (!response) {
      throw new MoError("E_DAEMON_DOWN", "连不上 host：" + (error && error.message ? error.message : error), {
        hint: "mo daemon status 看看",
      });
    }
  }

  // 旧构建的 host 没有 /local/router/* 路由，别让人去猜 404 是什么意思
  if (response && response.status === 404 && pathname.startsWith("/local/router/")) {
    throw new MoError("E_ROUTER_HOST_OLD", "host 是旧构建，还没有指挥台接口", {
      hint: "在仓库里用 MO_AGENT_ROOT=\"$PWD\" node host/index.mjs 起 host，或跑 ./scripts/build-desktop.sh 重建桌面运行时",
    });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || (payload && payload.ok === false)) {
    const code = (payload && payload.code) || "E_ROUTER_START_FAILED";
    const message = (payload && payload.error) || "host 返回 " + response.status;
    const details = {};
    if (payload && payload.hint) details.hint = payload.hint;
    if (payload && payload.detail) details.detail = payload.detail;
    throw new MoError(code, message, Object.keys(details).length ? details : undefined);
  }
  return payload || {};
}

function describe(status) {
  if (!status.running) {
    const lines = ["指挥台  未运行"];
    lines.push("  启动    mo router start");
    if (!status.onboarded) lines.push("  首次    先 mo router runtime install，再 mo router setup");
    return lines.join("\n");
  }
  const lines = ["指挥台  运行中（pid " + status.pid + "）"];
  if (status.model) lines.push("  模型    " + status.provider + " / " + status.model);
  if (status.runtime) lines.push("  运行时  " + status.runtime + " " + status.version);
  lines.push("  工作台  " + status.cwd);
  lines.push("  停止    mo router stop");
  return lines.join("\n");
}

async function runtimeCommand(home, args, ctx) {
  const action = args.positional[1] || "list";
  // 测试与脚本可以用 ctx.autoStart=false 关掉自动拉起
  const allowAuto = !(ctx && ctx.autoStart === false);

  if (action === "list") {
    const value = await callRouter(home, "/local/router/runtime/list", "GET", undefined, { autoStart: false });
    emit(args.options, value, (data) => {
      const lines = ["运行时  清单 pin 在 " + data.pinned + (data.inUse ? "，当前在用 " + data.inUse : "")];
      if (!data.runtimes.length) {
        lines.push("  还没有安装：mo router runtime install");
      } else {
        for (const item of data.runtimes) {
          const mark = item.version === data.inUse ? "*" : " ";
          lines.push("  " + mark + " " + item.version + (item.installed ? "" : "（文件缺失）"));
        }
      }
      return lines.join("\n");
    });
    return 0;
  }

  if (action === "install") {
    const version = one(args.options, "version");
    const force = has(args.options, "force");
    process.stderr.write("安装运行时" + (version ? " " + version : "") + "…（首次会下载约 150MB 依赖）\n");
    const value = await callRouter(home, "/local/router/runtime/install", "POST", {
      version: version || undefined,
      force,
    }, { autoStart: allowAuto });
    emit(args.options, value, (data) => {
      if (data.reused) return "✓ 运行时已存在（" + data.version + "），沿用 " + data.dir;
      return "✓ 运行时已安装（" + data.version + "）\n  " + data.dir + "\n  Node " + (data.nodeVersion || data.node);
    });
    return 0;
  }

  if (action === "prune") {
    const value = await callRouter(home, "/local/router/runtime/prune", "POST", undefined, { autoStart: allowAuto });
    emit(args.options, value, (data) => {
      if (!data.removed.length) return "没有需要清理的旧版本（保留：" + data.kept.join(" / ") + "）";
      return "✓ 已删除旧版本：" + data.removed.join(" / ") + "\n  保留：" + data.kept.join(" / ");
    });
    return 0;
  }

  throw new MoError("E_USAGE", "未知子命令：router runtime " + action, {
    hint: "mo router runtime install|list|prune",
  });
}

export async function routerCommand(ctx, args) {
  // 裸 `mo router` = 启动：用户不该为了打开指挥台记两层子命令
  const sub = args.positional[0] || "start";
  const home = (ctx && ctx.home) || os.homedir();
  const allowAuto = !(ctx && ctx.autoStart === false);

  if (sub === "runtime") return runtimeCommand(home, args, ctx);

  if (sub === "setup") {
    const provider = one(args.options, "provider");
    const model = one(args.options, "model");
    const apiKey = one(args.options, "key");
    const test = !has(args.options, "no-test");
    if (!provider && !apiKey) {
      throw new MoError("E_USAGE", "setup 需要 --provider 与 --key", {
        hint: 'mo router setup --provider deepseek --model deepseek-v4-flash --key sk-...',
      });
    }
    const value = await callRouter(home, "/local/router/setup", "POST", { provider, model, apiKey, test }, { autoStart: allowAuto });
    emit(args.options, value, (data) => {
      const lines = ["✓ 指挥台已配置"];
      lines.push("  模型    " + data.provider + " / " + data.model);
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
    const value = await callRouter(home, "/local/router/reset", "POST", undefined, { autoStart: allowAuto });
    emit(args.options, value, (data) => (data.removed ? "✓ 已删除 Router 的凭据" : "本来就没有凭据"));
    return 0;
  }

  if (sub === "start") {
    const value = await callRouter(home, "/local/router/start", "POST", undefined, { autoStart: allowAuto });
    emit(args.options, value, (data) => {
      if (data.attached) return "指挥台已在运行（pid " + data.pid + "），没有重复启动";
      const head = "✓ 指挥台已启动（pid " + data.pid + "）";
      const warnings = Array.isArray(data.warnings) && data.warnings.length ? "\n  " + data.warnings.join("\n  ") : "";
      return head + warnings + "\n  工作台  " + data.cwd + "\n  打开终端窗口后即可对话";
    });
    return 0;
  }

  if (sub === "stop") {
    const value = await callRouter(home, "/local/router/stop", "POST", undefined, { autoStart: false });
    emit(args.options, value, (data) => (data.stopped ? "✓ 指挥台已停止（pid " + data.pid + "）" : "指挥台本来就没在运行"));
    return 0;
  }

  if (sub === "status") {
    const value = await callRouter(home, "/local/router/status", "GET", undefined, { autoStart: false });
    emit(args.options, value, describe);
    return value.running ? 0 : 1;
  }

  if (sub === "restart") {
    await callRouter(home, "/local/router/stop", "POST", undefined, { autoStart: false }).catch(() => null);
    const value = await callRouter(home, "/local/router/start", "POST", undefined, { autoStart: allowAuto });
    emit(args.options, value, (data) => "✓ 指挥台已重启（pid " + data.pid + "）");
    return 0;
  }

  throw new MoError("E_USAGE", "未知子命令：router " + sub + "（" + USAGE + "）", { hint: USAGE });
}
