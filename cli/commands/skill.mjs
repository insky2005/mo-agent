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
 * 安装目标 —— 与 `mo worker list` 列出的执行者一致：
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
  agents: { path: ".agents/skills", note: "通用" },
  pi: { path: ".pi/agent/skills", note: "原生（与 agents 二选一）" },
  claude: { path: ".claude/skills" },
  codex: { path: ".codex/skills" },
  qodercli: { path: ".qoder/skills" },
  qoderclicn: { path: ".qoder-cn/skills" },
  qwen: { path: ".qwen/skills" },
};

export function resolveTargets(names) {
  const defaults = {};
  for (const [name, target] of Object.entries(AGENT_TARGETS)) {
    defaults[name] = { dir: path.join(home(), target.path), note: target.note || "" };
  }

  let requested = names;
  if (!requested.length) {
    // 默认：通用位置 + 已经装了配置目录的 Agent
    requested = Object.keys(defaults).filter((name) => {
      if (name === "agents") return true;
      if (name === "pi") return false; // pi 也会读 ~/.agents，默认不装第二份
      return isDir(path.dirname(defaults[name].dir));
    });
  }

  const out = [];
  const seen = new Set();
  for (const name of requested) {
    if (defaults[name]) {
      const { dir, note } = defaults[name];
      if (seen.has(dir)) continue; // 同一目录（agents / pi）只装一次
      seen.add(dir);
      out.push({ name, dir, note });
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
  return Object.entries(AGENT_TARGETS).map(([name, target]) => {
    const dir = path.join(home(), target.path);
    return {
      name,
      dir,
      note: target.note || "",
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
  const available = targets.filter((target) => target.available);

  const lines = ["为哪些 Agent 安装 mo 技能？", ""];
  targets.forEach((target, index) => {
    const mark = target.installed ? "[✓]" : target.available ? "[x]" : "[ ]";
    const state = target.installed ? "已装" : target.available ? "未装" : "不可用";
    lines.push("  " + (index + 1) + ") " + mark + " " + target.name.padEnd(11) + target.dir.padEnd(34) + state);
  });
  lines.push("", "[✓] 已装（重装会覆盖） [x] 可装 [ ] 不可用（对应 Agent 目录不存在）");
  lines.push("回车：处理全部可用的 " + available.length + " 项 | 输入编号（如 1,3）：只处理这些 | q 取消");
  process.stdout.write(lines.join("\n") + "\n> ");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("")).trim().toLowerCase();
    if (answer === "q") return [];
    if (answer === "") return available;
    const picked = new Set(
      answer.split(/[,\s]+/).map((part) => Number(part)).filter((n) => Number.isInteger(n) && n >= 1 && n <= targets.length),
    );
    return targets.filter((target, index) => picked.has(index + 1) && target.available);
  } finally {
    rl.close();
  }
}

export async function skillCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  const targets = resolveTargets(all(args.options, "target"));

  if (sub === "list") {
    const listed = all(args.options, "target").length ? targets : allTargets();
    const rows = listed.map((target) => {
      const installed = fs.existsSync(path.join(target.dir, SKILL_NAME, "SKILL.md"));
      return [target.name, installed ? "✓" : "✗", path.join(target.dir, SKILL_NAME), target.note || ""];
    });
    const installedNames = new Set(
      listed
        .filter((target) => fs.existsSync(path.join(target.dir, SKILL_NAME, "SKILL.md")))
        .map((target) => target.name),
    );
    // pi 同时读 ~/.agents 和 ~/.pi/agent；两处都装会被判同名冲突
    const duplicated = installedNames.has("agents") && installedNames.has("pi");
    const hint = duplicated
      ? "注意：agents 与 pi 各一份，pi 会告警；建议只留一处。"
      : "";

    emit(
      args.options,
      {
        targets: listed.map((target) => ({
          ...target,
          installed: fs.existsSync(path.join(target.dir, SKILL_NAME, "SKILL.md")),
        })),
        duplicated,
      },
      () =>
        table(rows, ["目标", "已装", "路径", "说明"]).replace(/[ \t]+$/gm, "")
        + (hint ? "\n\n" + hint : "")
        + "\n\n安装：mo skill install",
    );
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
    const done = new Set();
    for (const { name, dir } of chosen) {
      if (done.has(dir)) continue; // agents 与 pi 共用同一目录
      done.add(dir);
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
      const lines = written.map((item) => "✓ " + item.path);
      lines.push("技能已装，新开会话后生效。");
      if (!which("mo")) lines.push("提示：mo 不在 PATH。");
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
      removed.length ? removed.map((item) => "✓ 已移除 " + item.path).join("\n") : "没有需要移除的技能");
    return 0;
  }

  throw new MoError("E_USAGE", "未知子命令：skill " + sub + "（可用：install / uninstall / list）");
}