import fs from "node:fs";
import { makeRunId } from "../core/contract.mjs";
import { IDLE, TASK } from "../core/status.mjs";
import { preview, TranscriptAdapter } from "./transcript-adapter.mjs";

const MAX_READ_BYTES = 512 * 1024;
const DEFAULT_END_QUIET_MS = 2000;
const PROMPT_LIMIT = 4000;
const ANSWER_LIMIT = 12000;
const TITLE_LIMIT = 60;

function clip(text, max) {
  const value = String(text == null ? "" : text).trim();
  const limit = max || 4000;
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

function textFrom(blocks, types) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && types.includes(block.type) && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 从 WorkBuddy 的 user 条目里取真正的提问。
 *
 * 桌面端会把工作区信息、身份文件、memory/skills 提醒整段塞进
 * <system-reminder>…</system-reminder>，真正的提问在 <user_query>…</user_query>。
 * 没有 user_query 时退回「剥掉所有 system-reminder 后的剩余文本」。
 */
export function promptFrom(entry) {
  if (!entry || entry.type !== "message" || entry.role !== "user") return "";
  const raw = textFrom(entry.content, ["input_text", "text"]);
  if (!raw) return "";
  const query = raw.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  let value = query ? query[1] : raw
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system-reminder\b[^>]*>[\s\S]*$/i, "");
  value = value.replace(/<\/?(?:user_query|system-reminder)[^>]*>/gi, "").trim();
  return value ? clip(value, PROMPT_LIMIT) : "";
}

/** assistant 条目的可见正文；genie 用 output_text，兼容 text。 */
export function answerFrom(entry) {
  if (!entry || entry.type !== "message" || entry.role !== "assistant") return "";
  return clip(textFrom(entry.content, ["output_text", "text"]), ANSWER_LIMIT);
}

/**
 * WorkBuddy 桌面端（genie 内核）观测适配器。
 *
 * 数据源：~/.workbuddy/projects/<project-slug>/<sessionId>.jsonl
 *
 * 与 Claude Code / Qoder 的 transcript 不同：
 *   - 用户提问是 type:"message" + role:"user"，正文夹在 system-reminder 里；
 *   - assistant 正文是 type:"message" + role:"assistant" + content[].type="output_text"；
 *   - 工具调用 / 结果各写一条：function_call / function_call_result；
 *   - 没有 stop_reason，只能靠 assistant 消息 + 静默窗口判定一轮结束。
 *
 * 「等授权」仍由 PermissionRequest hook 负责，不在这一层。
 */
export class WorkBuddyAdapter extends TranscriptAdapter {
  constructor(options) {
    const opts = Object.assign({}, options || {}, {
      name: "workbuddy",
      rootEnv: "MO_AGENT_WORKBUDDY_ROOT",
      defaultRoot: "~/.workbuddy/projects",
      defaultLabel: "WorkBuddy",
      defaultTitle: "WorkBuddy 会话",
    });
    super(opts);
    // assistant 消息写完后可能还有同一轮的 function_call，等 2 秒再判完成。
    // 测试可以传 0，避免真的等两秒。
    this.endQuietMs = Number.isFinite(opts.endQuietMs) ? opts.endQuietMs : DEFAULT_END_QUIET_MS;
  }

  /** 一行里的用户提问；scanPrefix / history 共用同一套提取规则。 */
  userTurnText(line) {
    if (!line || line.indexOf('"role":"user"') === -1) return "";
    try {
      const entry = JSON.parse(line);
      return promptFrom(entry);
    } catch (error) {
      return "";
    }
  }

  /** 大文件只读尾部时，用头部找回 ai-title 和第一问。 */
  seedHead(st, file) {
    const length = Math.min(file.size, 64 * 1024);
    try {
      const fd = fs.openSync(file.path, "r");
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, 0);
      fs.closeSync(fd);
      const lines = buf.toString("utf8").split("\n");
      lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry;
        try {
          entry = JSON.parse(trimmed);
        } catch (error) {
          continue;
        }
        if (entry.type === "ai-title" && entry.aiTitle) st.title = entry.aiTitle;
        if (!st.firstPrompt) {
          const prompt = promptFrom(entry);
          if (prompt) st.firstPrompt = preview(prompt, 200);
        }
      }
    } catch (error) {
      this.log.debug("读取 WorkBuddy transcript 头部失败: " + error.message);
    }
    const tailStart = this.alignLineStart(file.path, Math.max(0, file.size - MAX_READ_BYTES));
    const prefix = this.scanPrefix(file.path, tailStart);
    st.turns = prefix.turns;
    if (prefix.lastPrompt) {
      if (!st.firstPrompt) st.firstPrompt = preview(prefix.lastPrompt, 200);
      st.lastPrompt = prefix.lastPrompt;
      st.promptFromUser = true;
    }
  }

  applyLine(st, line) {
    const trimmed = (line || "").trim();
    if (!trimmed) return;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (error) {
      return;
    }
    if (entry.sessionId) st.sessionId = entry.sessionId;
    if (entry.cwd) st.cwd = entry.cwd;

    switch (entry.type) {
      case "ai-title":
        if (entry.aiTitle) st.title = entry.aiTitle;
        break;
      case "message": {
        if (entry.role === "user") {
          const prompt = promptFrom(entry);
          if (!prompt) break;
          const previousEntry = st.lastEntry;
          st.turns += 1;
          st.lastText = "";
          st.lastEntry = "user";
          st.endCandidate = false;
          if (!st.firstPrompt) st.firstPrompt = preview(prompt, 200);
          st.lastPrompt = prompt;
          st.promptFromUser = true;
          st.turnStarted = true;
          if (previousEntry !== "user" || !st.activeRunId) {
            st.activeRunId = makeRunId(this.idFor(st.sessionId), st.turns || 1);
          }
          break;
        }
        if (entry.role === "assistant") {
          const answer = answerFrom(entry);
          st.lastEntry = "assistant";
          st.endCandidate = !!answer && entry.status !== "failed";
          if (answer) st.lastText = answer;
          break;
        }
        break;
      }
      case "function_call":
        st.lastEntry = "function_call";
        st.endCandidate = false;
        break;
      case "function_call_result":
        st.lastEntry = "function_call_result";
        st.endCandidate = false;
        break;
      case "reasoning":
        st.lastEntry = "reasoning";
        st.endCandidate = false;
        break;
      default:
        // session-meta / file-history-snapshot 等元数据不改变状态，
        // 否则任务完成后会被误判成 working / idle。
        break;
    }
  }

  /** 一轮结束：assistant 有正文，且 transcript 静默了一小段时间。 */
  deriveStatus(st) {
    const fresh = Date.now() - st.mtimeMs < this.activeMs;
    if (st.lastEntry === "assistant" && st.endCandidate) {
      const quiet = this.endQuietMs <= 0 || Date.now() - st.mtimeMs >= this.endQuietMs;
      return quiet ? TASK.COMPLETED : TASK.WORKING;
    }
    if (st.lastEntry === "user") return fresh ? TASK.WORKING : IDLE;
    if (st.lastEntry === "function_call" || st.lastEntry === "function_call_result" || st.lastEntry === "reasoning") {
      return fresh ? TASK.WORKING : IDLE;
    }
    return fresh ? TASK.WORKING : IDLE;
  }

  /** 把「静默窗口」翻译成基类认识的 turnEnded；基类负责发 run.completed。 */
  publish(st) {
    st.turnEnded = !!st.endCandidate
      && (this.endQuietMs <= 0 || Date.now() - st.mtimeMs >= this.endQuietMs);
    super.publish(st);
  }

  /** 优先用 WorkBuddy 的 ai-title；没有就第一问截断到 60 字。 */
  titleFor(st) {
    if (st.title) return st.title;
    const fallback = st.firstPrompt || st.lastPrompt || this.defaultTitle;
    return preview(fallback, TITLE_LIMIT);
  }

  /** 按需读取整个 transcript，归并成按轮次排列的历史。 */
  history(sessionId, options) {
    const limit = Math.min(50, Math.max(1, Number(options && options.limit) || 20));
    const st = [...this.sessions.values()].find((item) => this.idFor(item.sessionId) === sessionId);
    if (!st || !st.path) return { turns: [], truncated: false, total: 0 };
    let raw = "";
    try {
      raw = fs.readFileSync(st.path, "utf8");
    } catch (error) {
      return { turns: [], truncated: false, total: 0 };
    }
    const all = [];
    let current = null;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch (error) {
        continue;
      }
      if (entry.type !== "message") continue;
      if (entry.role === "user") {
        const prompt = promptFrom(entry);
        if (!prompt) continue;
        current = { turn: all.length + 1, prompt, response: "" };
        all.push(current);
      } else if (entry.role === "assistant" && current) {
        const response = answerFrom(entry);
        if (response) current.response = response;
      }
    }
    return {
      turns: all.slice(-limit),
      truncated: all.length > limit,
      total: all.length,
    };
  }
}
