/**
 * 旧命令的迁移登记表（E1–E6 的别名过渡）。
 *
 * 原则：旧名字继续可用，但每次会话只提示一次，并写明**哪个版本移除**——
 * 没有期限的"兼容"等于永远兼容，命令面就永远收不干净。
 */
export const REMOVE_IN = "0.5.0";

export const DEPRECATIONS = Object.freeze({
  "mo receipt": { to: "mo internal receipt" },
  "mo watchdog": { to: "mo internal watchdog" },
  "mo completion": { to: "mo internal completion" },
  "mo memory init": { to: "mo memory create" },
  "mo memory migrate": { to: "mo internal memory-migrate" },
  "mo worker current": { to: "mo worker use" },
  "mo terminal current": { to: "mo terminal use" },
  "mo project agent": { to: "mo connect project" },
});

const shown = new Set();

/** 打一行迁移提示（同一进程内同一命令只提示一次）。 */
export function deprecate(command, options = {}) {
  const item = DEPRECATIONS[command];
  if (!item) return false;
  if (shown.has(command)) return false;
  shown.add(command);
  const write = (options.stream || process.stderr).write.bind(options.stream || process.stderr);
  write("[deprecated] " + command + " → " + item.to + "（旧名字仍可用，将在 " + REMOVE_IN + " 移除）\n");
  return true;
}

/** 测试用：重置"已提示"记录。 */
export function resetDeprecations() {
  shown.clear();
}
