import { preview, TranscriptAdapter } from "./transcript-adapter.mjs";
import { createTitleSource, defaultDbPath } from "./qoder-cn-titles.mjs";

const FALLBACK_TITLE_LIMIT = 60;

/**
 * Qoder CN 桌面端（智能工作台）适配器。
 *
 * 桌面端底层跑的就是 Qoder CLI：会话 transcript 落在
 * ~/.qoder-cn/projects/<project>/<sessionId>.jsonl，字段与 Claude Code 同构：
 *   - user / assistant，assistant.message.stop_reason = end_turn / tool_use
 *   - 工具结果写成 type:"user" + content:[{type:"tool_result"}]
 * 所以观测层直接复用 TranscriptAdapter；「等授权」由 PermissionRequest hook 负责。
 *
 * transcript 里没有 ai-title，真正的会话标题在 Qoder CN 的 SQLite（chat_sessions.title）；
 * 读不到时才退回第一问，并截断到 60 字，避免卡片被长 prompt 撑满。
 */
export class QoderCnAdapter extends TranscriptAdapter {
  constructor(options) {
    const opts = Object.assign({}, options || {}, {
      name: "qoder-cn",
      rootEnv: "MO_AGENT_QODER_CN_ROOT",
      defaultRoot: "~/.qoder-cn/projects",
      defaultLabel: "Qoder CN",
      defaultTitle: "Qoder CN 会话",
    });
    super(opts);
    const log = opts.log && typeof opts.log.debug === "function" ? opts.log : { debug() {} };
    this.titleSource = opts.titleSource || createTitleSource({
      dbPath: opts.titleDbPath || process.env.MO_AGENT_QODER_CN_DB || defaultDbPath(),
      log,
    });
  }

  prepare() {
    this.titleSource.refresh();
  }

  /** 优先用 Qoder CN 自己的会话标题；没有就第一问截断到 60 字。 */
  titleFor(st) {
    const exact = this.titleSource.title(st.sessionId);
    if (exact) return exact;
    const fallback = st.firstPrompt || st.lastPrompt || this.defaultTitle;
    return preview(fallback, FALLBACK_TITLE_LIMIT);
  }
}
