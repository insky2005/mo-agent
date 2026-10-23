import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { SKILL_MD, SKILL_NAME } from "../lib/skill-content.mjs";
import readline from "node:readline/promises";
import { all, has } from "../lib/args.mjs";
import { which } from "../lib/executors.mjs";
import { emit, table } from "../lib/output.mjs";

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function home() {
  return process.env.HOME || os.homedir();
}

/**
 * 安装目标 —— 与 `mo agents` 支持的执行者一致：
 *
 *   agents      ~/.agents/skills     通用位置（本机已有，多个工具共享）
 *   claude      ~/.claude/skills
 *   codex       ~/.codex/skills
 *   qodercli    ~/.qoder/skills
 *   qoderclicn  ~/.qoder-cn/skills
 *   qwen        ~/.qwen/skills
 *
 * pi 没有固定的 skills 目录，用 `pi --skill <path>` 指过来。
 */
export const AGENT_TARGETS = {
  agents: ".agents/skills",
  claude: ".claude/skills",
  codex: ".codex/skills",
  qodercli: ".qoder/skills",
  qoderclicn: ".qoder-cn/skills",
  qwen: ".qwen/skills",
};

export function resolveTargets(names) {
  const defaults = {};
  for (const [name, relative] of Object.entries(AGENT_TARGETS)) {
    defaults[name] = path.join(home(), relative);
  }

  let requested = names;
  if (!requested.length) {
    // 默认：通用位置 + 已经装了配置目录的 Agent
    requested = Object.keys(defaults).filter((name) => {
      if (name === "agents") return true;
      return isDir(path.dirname(defaults[name]));
    });
  }

  const out = [];
  for (const name of requested) {
    if (defaults[name]) {
      out.push({ name, dir: defaults[name] });
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

export function allTargets() {
  return Object.entries(AGENT_TARGETS).map(([name, relative]) => {
    const dir = path.join(home(), relative);
    return {
      name,
      dir,
      available: name === "agents" || isDir(path.dirname(dir)),
      installed: fs.existsSync(path.join(dir, SKILL_NAME, "SKILL.md")),
    };
  });
}

/**
 * 交互式选择要装到哪些目标。
 * 空输入 = 默认（可用的那些）；a = 全部可用；q = 取消。
 */
async function chooseTargets() {
  const targets = allTargets();
  const selected = new Set(targets.filter((t) => t.available).map((t) => t.name));

  const lines = ["为哪些 Agent 安装 mo 技能？", ""];
  targets.forEach((target, index) => {
    const mark = selected.has(target.name) ? "[x]" : "[ ]";
    const note = target.installed ? "（已装）" : target.available ? "" : "（未安装）";
    lines.push("  " + (index + 1) + ") " + mark + " " + target.name.padEnd(11) + target.dir + note);
  });
  lines.push("", "选择：1,3 收尾 | a 全选可用 | 回车 用默认 | q 取消");
  process.stdout.write(lines.join("\n") + "\n> ");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("")).trim().toLowerCase();
    if (answer === "q") return [];
    if (answer === "a") return targets.filter((t) => t.available);
    if (answer === "" || answer === "d") return targets.filter((t) => selected.has(t.name));
    const picked = new Set(
      answer.split(/[,\s]+/).map((part) => Number(part)).filter((n) => Number.isInteger(n) && n >= 1 && n <= targets.length),
    );
    return targets.filter((target, index) => picked.has(index + 1));
  } finally {
    rl.close();
  }
}

export async function skillCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  const targets = resolveTargets(all(args.options, "target"));

  if (sub === "list") {
    const rows = targets.map(({ name, dir }) => {
      const installed = fs.existsSync(path.join(dir, SKILL_NAME, "SKILL.md"));
      return [name, installed ? "✓" : "✗", path.join(dir, SKILL_NAME)];
    });
    emit(args.options, { targets: targets.map((t) => ({ ...t, installed: fs.existsSync(path.join(t.dir, SKILL_NAME, "SKILL.md")) })) },
      () => table(rows, ["目标", "已装", "路径"]) + "\n\n安装：mo skill install（交互选择）或 --target <名称|目录> --yes");
    return 0;
  }

  if (sub === "install") {
    let chosen = targets;
    if (!all(args.options, "target").length && has(args.options, "yes") === false && process.stdin.isTTY) {
      chosen = await chooseTargets();
      if (!chosen.length) {
        emit(args.options, { ok: false, cancelled: true }, "已取消");
        return 0;
      }
    }
    const written = [];
    for (const { name, dir } of chosen) {
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
    emit(args.options, { ok: true, written, moOnPath: Boolean(which("mo")) }, () => {
      const lines = written.map((item) => "已安装 " + item.path);
      lines.push("", "新开会话后技能才会加载。");
      if (!which("mo")) {
        lines.push("注意：mo 不在 PATH 里。技能会先让主 Agent 安装 mo；也可以现在把安装目录加进 PATH。");
      }
      return lines.join("\n");
    });
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