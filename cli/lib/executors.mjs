/**
 * 常见 Agent 的执行模板。
 *
 * 收录原则：非交互、能从 stdin 读 prompt、且**能写文件**——
 * 写不了 $MO_RECEIPT 的执行者拿不到 done，给了也是坑。
 *
 * 桌面端 Agent（Qoder 桌面版、WorkBuddy）没有 headless 入口，不在这里。
 */
import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";

export const EXECUTORS = {
  claude: {
    command: 'claude -p "$(cat)" --permission-mode acceptEdits',
    description: "Claude Code，允许在工作区改文件",
    requires: "claude",
  },
  codex: {
    command: "codex exec -s workspace-write -",
    description: "Codex CLI，工作区可写",
    requires: "codex",
  },
  qodercli: {
    command: 'qodercli -p "$(cat)" --permission-mode accept_edits',
    description: "Qoder CLI（国际版），允许改文件",
    requires: "qodercli",
  },
  qoderclicn: {
    command: 'qoderclicn -p "$(cat)" --permission-mode accept_edits',
    description: "Qoder CLI（CN 版），允许改文件",
    requires: "qoderclicn",
  },
  pi: {
    command: 'pi -p "$(cat)"',
    description: "pi，非交互模式",
    requires: "pi",
  },
  qwen: {
    command: 'qwen --approval-mode auto-edit "$(cat)"',
    description: "Qwen Code，自动批准文件编辑",
    requires: "qwen",
  },
};

export function resolveAgent(name) {
  const key = String(name).trim();
  const preset = EXECUTORS[key];
  if (!preset) {
    throw new MoError("E_USAGE", "未知执行者模板：" + key, {
      hint: "可用：" + Object.keys(EXECUTORS).join(" / ") + "；自定义命令请用 --exec",
    });
  }
  return { name: key, ...preset };
}

/** 在 PATH 里找可执行文件（不执行它） */
export function which(binary) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续找
    }
  }
  return null;
}

export function listAgents() {
  return Object.entries(EXECUTORS).map(([name, preset]) => {
    const found = which(preset.requires);
    return {
      name,
      command: preset.command,
      description: preset.description,
      requires: preset.requires,
      installed: Boolean(found),
      path: found,
    };
  });
}
