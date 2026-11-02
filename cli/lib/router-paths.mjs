import os from "node:os";
import path from "node:path";

/**
 * Router 的路径计算（纯函数，不碰文件系统）。
 * 目录约定见 docs/spec/router.md §3。
 *
 * 两个不同的 "home"，别混：
 *  - dataDir  = mo 的数据目录（~/.mo-agent，或 MO_AGENT_HOME）
 *  - osHome   = 操作系统用户目录（~），只用来推程序产物路径
 * 这两者混过一次：CLI 传进来的是 dataDir，而这里又拼了一次 .mo-agent，
 * 结果凭据写到了 ~/.mo-agent/.mo-agent/router/credentials.json。
 */

/** mo 的数据目录（与 cli/lib/paths.mjs 的 moHome() 同义） */
export function moDataDir(env) {
  const source = env || process.env;
  return path.resolve(source.MO_AGENT_HOME || path.join(os.homedir(), ".mo-agent"));
}

/** dataDir 下的 router 目录 */
export function routerRoot(dataDir) {
  return path.join(dataDir, "router");
}

export function routerFile(home) {
  return path.join(routerRoot(home), "router.json");
}

export function routerPidFile(home) {
  return path.join(routerRoot(home), "router.pid");
}

export function routerLogFile(home) {
  return path.join(routerRoot(home), "router.log");
}

export function startScriptFile(home) {
  return path.join(routerRoot(home), "start.sh");
}

/** 密钥投影：只在 Router 运行期间存在（0600），stop 时删除 */
export function secretsFile(home) {
  return path.join(routerRoot(home), "secrets.sh");
}

export function credentialsFile(home) {
  return path.join(routerRoot(home), "credentials.json");
}

/** Pi 的 settings.json：模型与思考等级的落点（Pi 会自己读写它） */
export function settingsFile(home) {
  return path.join(configDir(home), "settings.json");
}

/** 私有配置目录：PI_CODING_AGENT_DIR 指向这里，绝不回落用户全局 */
export function configDir(home) {
  return path.join(routerRoot(home), "config");
}

export function sessionsDir(home) {
  return path.join(routerRoot(home), "sessions");
}

export function workbenchDir(home) {
  return path.join(routerRoot(home), "workbench");
}

export function contractFile(home) {
  return path.join(workbenchDir(home), "ROUTER.md");
}

export function workbenchReadme(home) {
  return path.join(workbenchDir(home), "README.md");
}

export function extensionFile(home) {
  return path.join(configDir(home), "extensions", "mo-agent-control.js");
}

/** Pi 的 MCP 配置：写在私有配置目录里，不碰用户全局 ~/.pi/agent/mcp.json */
export function mcpConfigFile(home) {
  return path.join(configDir(home), "mcp.json");
}

/**
 * 程序产物根目录。与桌面运行时同源，见 docs/plans/desktop-cross-platform.md。
 * MO_AGENT_RUNTIME_ROOT 可覆盖（测试与非常规安装用）。
 */
export function runtimeRoot(options) {
  const opts = options || {};
  const home = opts.home;
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  if (env.MO_AGENT_RUNTIME_ROOT) return path.resolve(env.MO_AGENT_RUNTIME_ROOT);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "mo-agent");
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "mo-agent");
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "mo-agent");
}

/** 某个运行时的安装根：<runtimeRoot>/routers/<id>/<version> */
export function runtimeInstallDir(options) {
  const opts = options || {};
  return path.join(runtimeRoot(opts), "routers", String(opts.id), String(opts.version));
}
