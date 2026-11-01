import { MoError } from "../../core/errors.mjs";

/** POSIX 安全的单引号包裹；生成启动脚本时只走这一个函数，避免手工拼引号。 */
export function shellQuote(value) {
  const text = String(value == null ? "" : value);
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/**
 * 渲染 Router 的启动脚本。
 *
 * 为什么用脚本而不是直接 spawn：终端窗口只能执行一个文件，而 Router 需要
 * cwd + 一组环境变量 + 一条很长的参数，塞进命令行会到处是引号。脚本也让
 * pid 的取得变简单（\`echo $$\` 就是最终 exec 的那个进程）。
 *
 * 注意：脚本里含凭据环境变量，因此必须 0600/0700，且不进任何仓库。
 */
export function renderRouterScript(options) {
  const opts = options || {};
  if (!opts.bin) throw new MoError("E_ROUTER_START_FAILED", "启动脚本缺少可执行文件");
  if (!opts.pidFile) throw new MoError("E_ROUTER_START_FAILED", "启动脚本缺少 pid 文件路径");

  const args = Array.isArray(opts.args) ? opts.args : [];
  const lines = [
    "#!/bin/sh",
    "# 由 mo router 生成，不要手改：每次启动都会覆盖。",
    "echo $$ > " + shellQuote(opts.pidFile),
  ];
  if (opts.cwd) lines.push("cd " + shellQuote(opts.cwd) + " || exit 1");
  for (const [name, value] of Object.entries(opts.env || {})) {
    if (value === undefined || value === null || value === "") continue;
    lines.push("export " + name + "=" + shellQuote(value));
  }
  const command = [shellQuote(opts.bin), ...args.map(shellQuote)].join(" ");
  if (opts.logFile) {
    lines.push("exec " + command + " >> " + shellQuote(opts.logFile) + " 2>&1");
  } else {
    lines.push("exec " + command);
  }
  return lines.join("\n") + "\n";
}
