import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { SKILL_MD, SKILL_NAME } from "../lib/skill-content.mjs";
import { all } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";

function home() {
  return process.env.HOME || os.homedir();
}

/** dsh / claude / 任意目录，带默认目标 */
export function resolveTargets(names, options = {}) {
  const defaults = {
    dsh: path.join(process.env.DSH_HOME || path.join(home(), ".dsh"), "skills"),
    claude: path.join(home(), ".claude", "skills"),
  };
  const requested = names.length ? names : Object.keys(defaults);
  const out = [];
  for (const name of requested) {
    if (defaults[name]) {
      const dir = defaults[name];
      const parent = path.dirname(dir);
      if (!names.length && !fs.existsSync(parent)) continue; // 默认目标：没装这个 Agent 就跳过
      out.push({ name, dir });
    } else if (path.isAbsolute(name) || name.startsWith(".")) {
      out.push({ name, dir: path.resolve(process.cwd(), name) });
    } else {
      throw new MoError("E_USAGE", "未知目标：" + name, {
        hint: "可用：dsh / claude / 绝对路径",
      });
    }
  }
  return out;
}

export function skillCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  const targets = resolveTargets(all(args.options, "target"));

  if (sub === "list") {
    const rows = targets.map(({ name, dir }) => {
      const installed = fs.existsSync(path.join(dir, SKILL_NAME, "SKILL.md"));
      return [name, installed ? "✓" : "✗", path.join(dir, SKILL_NAME)];
    });
    emit(args.options, { targets: targets.map((t) => ({ ...t, installed: fs.existsSync(path.join(t.dir, SKILL_NAME, "SKILL.md")) })) },
      () => table(rows, ["目标", "已装", "路径"]) + "\n\n安装：mo skill install [--target dsh|claude|<目录>]");
    return 0;
  }

  if (sub === "install") {
    const written = [];
    for (const { name, dir } of targets) {
      const dest = path.join(dir, SKILL_NAME, "SKILL.md");
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, SKILL_MD);
      } catch (error) {
        throw new MoError("E_SKILL_WRITE", "写入失败：" + dir + "（" + (error.code || error.message) + "）", {
          hint: "检查目录权限，或用 --target 指定可写目录",
        });
      }
      written.push({ target: name, path: dest });
    }
    emit(args.options, { ok: true, written }, () =>
      written.map((item) => "已安装 " + item.path).join("\n") + "\n\n新开会话后技能才会加载。");
    return 0;
  }

  if (sub === "uninstall") {
    const removed = [];
    for (const { name, dir } of targets) {
      const skillDir = path.join(dir, SKILL_NAME);
      if (!fs.existsSync(skillDir)) continue;
      try {
        fs.rmSync(skillDir, { recursive: true, force: true });
      } catch (error) {
        throw new MoError("E_SKILL_WRITE", "删除失败：" + skillDir + "（" + (error.code || error.message) + "）", {
          hint: "检查目录权限",
        });
      }
      removed.push({ target: name, path: skillDir });
    }
    emit(args.options, { ok: true, removed }, () =>
      removed.length ? removed.map((item) => "已移除 " + item.path).join("\n") : "没有需要移除的技能");
    return 0;
  }

  throw new MoError("E_USAGE", "未知子命令：skill " + sub + "（可用：install / uninstall / list）");
}