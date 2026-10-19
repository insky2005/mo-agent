import { TranscriptAdapter } from "./transcript-adapter.mjs";

/**
 * Claude Code 观测适配器（L2：transcript 层）。
 * transcript 解析统一放在 transcript-adapter.mjs，这里只声明 Claude 的目录与命名。
 */
export class ClaudeCodeAdapter extends TranscriptAdapter {
  constructor(options) {
    super(Object.assign({}, options || {}, {
      name: "claude-code",
      rootEnv: "MO_AGENT_CLAUDE_ROOT",
      defaultRoot: "~/.claude/projects",
      defaultLabel: "Claude Code",
      defaultTitle: "Claude Code 会话",
    }));
  }
}
