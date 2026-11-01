import path from "node:path";

/**
 * Router 的路径计算（纯函数，不碰文件系统）。
 * 目录约定见 docs/spec/router.md §3。
 */

export function routerRoot(home) {
  return path.join(home, ".mo-agent", "router");
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

export function credentialsFile(home) {
  return path.join(routerRoot(home), "credentials.json");
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
