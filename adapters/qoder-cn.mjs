import { TranscriptAdapter } from "./transcript-adapter.mjs";

/**
 * Qoder CN 桌面端（智能工作台）适配器。
 *
 * 桌面端底层跑的就是 Qoder CLI：会话 transcript 落在
 * ~/.qoder-cn/projects/<project>/<sessionId>.jsonl，字段与 Claude Code 同构：
 *   - user / assistant，assistant.message.stop_reason = end_turn / tool_use
 *   - 工具结果写成 type:"user" + content:[{type:"tool_result"}]
 * 所以观测层直接复用 TranscriptAdapter；「等授权」由 PermissionRequest hook 负责。
 *
 * 没有 ai-title 条目，标题退回第一问；桌面端的正式标题在 SQLite 里，后续可选增强。
 */
export class QoderCnAdapter extends TranscriptAdapter {
  constructor(options) {
    super(Object.assign({}, options || {}, {
      name: "qoder-cn",
      rootEnv: "MO_AGENT_QODER_CN_ROOT",
      defaultRoot: "~/.qoder-cn/projects",
      defaultLabel: "Qoder CN",
      defaultTitle: "Qoder CN 会话",
    }));
  }
}
