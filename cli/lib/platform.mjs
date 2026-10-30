import fs from "node:fs";
import path from "node:path";

/**
 * 平台相关的纯逻辑：PATH 拆分、PATHEXT、shell 选择。
 *
 * 这里不读全局状态（默认参数除外），方便测试时注入 platform / env。
 */

const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/** 按平台的 PATH 分隔符拆目录 */
export function pathDirs(pathValue, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return String(pathValue || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Windows 用 PATHEXT；其它平台只有"原样"一个候选 */
export function executableExtensions(platform = process.platform, env = process.env) {
  if (platform !== "win32") return [""];
  const raw = String(env.PATHEXT || "").trim();
  const fromEnv = raw
    ? raw.split(";").map((item) => item.trim()).filter(Boolean)
    : [];
  return fromEnv.length ? fromEnv : DEFAULT_PATHEXT;
}

function isRunnableFile(candidate, platform) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    // Windows 没有执行位，能读到文件即可；POSIX 仍然要求 X_OK
    fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 里找可执行文件。返回绝对/相对路径，找不到返回 null。
 * binary 带路径分隔符时只查那个位置。
 */
export function findExecutable(binary, { platform = process.platform, env = process.env } = {}) {
  const name = String(binary || "").trim();
  if (!name) return null;

  const extensions = executableExtensions(platform, env);
  const hasSeparator = name.includes("/") || name.includes("\\");

  if (hasSeparator) {
    if (isRunnableFile(name, platform)) return name;
    if (platform === "win32") {
      for (const ext of extensions) {
        if (isRunnableFile(name + ext, platform)) return name + ext;
      }
    }
    return null;
  }

  for (const dir of pathDirs(env.PATH, platform)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (isRunnableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/**
 * 执行命令时用哪个 shell：
 *   MO_SHELL 显式覆盖；Windows 用 %ComSpec%（默认 cmd.exe）；其它平台 /bin/sh。
 */
export function resolveShell(platform = process.platform, env = process.env) {
  const override = String(env.MO_SHELL || "").trim();
  if (override) return override;
  if (platform === "win32") return String(env.ComSpec || "cmd.exe");
  return "/bin/sh";
}
