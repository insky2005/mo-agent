/**
 * 常见 Agent 的执行模板。
 *
 * 只收录"能从 stdin 读 prompt、能写文件"的非交互用法；
 * 桌面端 Agent（Qoder、WorkBuddy）没有 headless 入口，不在这里。
 *
 * 模板只是默认值：需要额外参数时用 --exec 写完整命令，或直接改卡里的 exec。
 */
import { MoError } from "../../core/errors.mjs";

export const EXECUTORS = {
  claude: {
    command: 'claude -p "$(cat)"',
    description: "Claude Code，只读；需要改文件用 claude-edit",
    requires: "claude",
  },
  "claude-edit": {
    command: 'claude -p "$(cat)" --permission-mode acceptEdits',
    description: "Claude Code，允许在工作区改文件",
    requires: "claude",
  },
  codex: {
    command: "codex exec -s workspace-write -",
    description: "Codex CLI，工作区可写",
    requires: "codex",
  },
  "codex-readonly": {
    command: "codex exec -s read-only -",
    description: "Codex CLI，只读",
    requires: "codex",
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

export function listAgents() {
  return Object.entries(EXECUTORS).map(([name, preset]) => ({
    name,
    command: preset.command,
    description: preset.description,
    requires: preset.requires,
  }));
}
