import { has, one } from "../lib/args.mjs";
import { emit, isJson } from "../lib/output.mjs";
import { MoError } from "../../core/errors.mjs";
import { runUpgrade } from "../lib/upgrade.mjs";
import { moHome } from "../lib/paths.mjs";

/**
 * mo upgrade —— 查新版并替换自己。
 *
 * 默认「检查 → 下载 → 校验 → 替换」；--check 只检测，--dry-run 只打印计划。
 * 退出码：0 表示命令跑通（--check 发现新版也是 0，用 --json 的 updateAvailable 判断），
 * 1 表示网络/校验/权限等失败，2 表示用法错误。
 */
export async function upgradeCommand(ctx, args) {
  if (args.positional.length) {
    throw new MoError("E_USAGE", "upgrade 不接受位置参数：" + args.positional[0], {
      hint: "用 mo upgrade [--check|--dry-run|--version <标签>|--force]",
    });
  }
  const options = args.options;
  const checkOnly = has(options, "check");
  const dryRun = has(options, "dry-run");
  const force = has(options, "force");
  const version = one(options, "version");
  if (version === true) throw new MoError("E_USAGE", "缺少版本号", { hint: "例：mo upgrade --version cli-v0.3.0" });
  if (checkOnly && force) throw new MoError("E_USAGE", "--check 与 --force 不能一起用");

  const result = await runUpgrade({
    checkOnly,
    dryRun,
    force,
    version: version === undefined ? null : version,
    repo: one(options, "repo") || ctx.env.MO_AGENT_REPO || undefined,
    home: moHome(ctx.env),
    env: ctx.env,
    log: (line) => {
      if (!isJson(options)) process.stderr.write(line + "\n");
    },
  });

  emit(options, { ok: true, ...result }, () => render(result));
  return 0;
}

function render(result) {
  const lines = [];
  if (result.checkOnly) {
    if (result.updateAvailable) {
      lines.push("当前 " + result.current + " → 最新 " + result.latest + "（" + result.tag + "）");
      lines.push("有新版本：mo upgrade");
    } else if (result.skipped === "local-newer") {
      lines.push("当前 " + result.current + " 比最新发布 " + result.latest + " 还新（本地构建？）");
    } else {
      lines.push("当前 " + result.current + "，已是最新（" + result.tag + "）");
    }
    return lines.join("\n");
  }

  if (result.dryRun) {
    lines.push("将升级 " + result.current + " → " + result.latest + "（" + result.tag + "）");
    lines.push("");
    lines.push("  资产   " + result.asset);
    lines.push("  位置   " + (result.path || "（未识别安装方式）"));
    lines.push("");
    lines.push("--dry-run：没有下载、没有写盘");
    return lines.join("\n");
  }

  if (result.installed) {
    lines.push("✓ 已升级 " + result.current + " → " + result.latest);
    lines.push("");
    lines.push("  位置   " + result.path);
    lines.push("  资产   " + result.asset);
    lines.push("  校验   sha256 通过");
    return lines.join("\n");
  }

  if (result.skipped === "local-newer") {
    return "当前 " + result.current + " 比最新发布 " + result.latest + " 还新（本地构建？）";
  }
  return ["当前 " + result.current + "，已是最新（" + result.tag + "）", "想重装同版本：mo upgrade --force"].join("\n");
}
