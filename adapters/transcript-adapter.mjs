import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EVENT, makeRunId } from "../core/contract.mjs";
import { TASK, IDLE } from "../core/status.mjs";

const MAX_READ_BYTES = 512 * 1024;

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function preview(text, max) {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const limit = max || 200;
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

/** 保留换行/缩进的截断，供详情层显示；标题仍用 preview 压成一行。 */
function truncateText(text, max) {
  const value = String(text == null ? "" : text).trim();
  const limit = max || 4000;
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

/** 从 user 条目里取真正的用户输入；tool_result / meta / sidechain 不算。 */
/** assistant 条目里的可见文本。 */
function assistantText(entry) {
  const content = entry && entry.message && entry.message.content;
  if (typeof content === "string") return truncateText(content, 12000);
  if (!Array.isArray(content)) return "";
  return truncateText(
    content.filter((p) => p && p.type === "text" && p.text).map((p) => p.text).join("\n"),
    12000
  );
}

function userText(entry) {
  // isCompactSummary：上下文压缩后 CLI 自己注入的「上次聊到哪」摘要，
  // 不是用户提问，不能显示成「你：」也不能算一轮。
  if (!entry || entry.isMeta || entry.isSidechain || entry.isCompactSummary === true) return "";
  const content = entry.message && entry.message.content;
  const blocks = Array.isArray(content) ? content : [];
  if (blocks.some((c) => c && c.type === "tool_result")) return "";
  const text = typeof content === "string"
    ? content
    : blocks.filter((c) => c && c.type === "text" && c.text).map((c) => c.text).join(" ");
  return text && text.trim() ? truncateText(text, 4000) : "";
}

/**
 * transcript 观测适配器基类（L2）。
 * 只要 Agent 把会话写成 Claude Code 风格的 JSONL（user / assistant / stop_reason），
 * 就能用同一套解析：在跑 / 干完了 / 停了。
 * 「在等授权」不在这一层，必须靠各家的 PermissionRequest hook。
 */
export class TranscriptAdapter {
  constructor(options) {
    const opts = options || {};
    this.name = opts.name || (opts.profile && opts.profile.id) || "claude-code";
    this.prefix = opts.prefix || this.name + ":";
    this.rootEnv = opts.rootEnv || "";
    this.defaultRoot = opts.defaultRoot || "~/.claude/projects";
    this.defaultLabel = opts.defaultLabel || "Claude Code";
    this.defaultTitle = opts.defaultTitle || "Claude Code 会话";
    this.hub = opts.hub;
    this.log = opts.log || (() => {});
    this.profile = opts.profile || {};
    this.agentLabel = this.profile.label || this.defaultLabel;
    // runEnd: explicit | inferred | none；none 时只更新状态，不发完成信号。
    this.runEnd = (this.profile.capabilities && this.profile.capabilities.runEnd) || "explicit";
    // 测试/诊断可以指向别处，避免本机真实 transcript 污染集成测试。
    this.root = expandHome(
      (this.rootEnv && process.env[this.rootEnv])
      || (this.profile.session && this.profile.session.root)
      || this.defaultRoot
    );
    this.pollMs = opts.pollMs || 2000;
    this.activeWindowMs = opts.activeWindowMs || 24 * 3600 * 1000;
    this.activeMs = opts.activeMs || 45000;
    this.sessions = new Map();
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (!fs.existsSync(this.root)) {
      this.log.warn(this.name + " 目录不存在，适配器跳过: " + this.root);
      return;
    }
    this.log.info(this.name + " 适配器已启动，监听 " + this.root);
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 规范 sessionId：既用于 hub，也用于 hook 里的 session_id 对齐。 */
  idFor(sessionId) {
    return this.prefix + sessionId;
  }

  /** 会话标题：优先厂商标题，其次第一问；最新一问只放 lastPrompt。 */
  titleFor(st) {
    return st.title || st.firstPrompt || st.lastPrompt || this.defaultTitle;
  }

  listFiles() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (error) {
      return out;
    }
    // 会话目录可能再套一层：桌面端是 <project>/<id>.jsonl，
    // Qoder CN IDE 是 <project>/transcript/<id>.jsonl，两种都要认。
    const visit = (dirPath, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch (error) {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth < 1) visit(path.join(dirPath, entry.name), depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const p = path.join(dirPath, entry.name);
        let stat;
        try {
          stat = fs.statSync(p);
        } catch (error) {
          continue;
        }
        if (Date.now() - stat.mtimeMs > this.activeWindowMs) continue;
        out.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    };
    for (const dir of dirs) {
      if (dir.isDirectory()) visit(path.join(this.root, dir.name), 0);
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out.slice(0, 40);
  }

  tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.poll();
    } catch (error) {
      this.log.debug(this.name + " 轮询失败: " + error.message);
    } finally {
      this.busy = false;
    }
  }

  /** 子类预热钩子：例如刷新会话标题缓存。 */
  prepare() {}

  poll() {
    try {
      this.prepare();
    } catch (error) {
      this.log.debug(this.name + " prepare 失败: " + error.message);
    }
    const files = this.listFiles();
    const seen = new Set();
    for (const file of files) {
      seen.add(file.path);
      this.ingest(file);
    }
    for (const [p, st] of [...this.sessions]) {
      if (seen.has(p)) continue;
      this.sessions.delete(p);
      const sessionId = this.idFor(st.sessionId);
      this.hub.emit("session.removed", { id: sessionId, sessionId, agent: this.name });
    }
  }

  ingest(file) {
    let st = this.sessions.get(file.path);
    if (!st) {
      st = { path: file.path, sessionId: path.basename(file.path, ".jsonl"), offset: 0, rest: "", lastEntry: null, lastStop: null, lastText: "", cwd: "", title: "", firstPrompt: "", lastPrompt: "", promptFromUser: false, turns: 0, status: null, runActive: false, turnStarted: false, turnEnded: false, updatedAt: file.mtimeMs };
      this.sessions.set(file.path, st);
      // 大文件只读尾部时，先单独扫一遍头部，保证会话名来自第一问而不是最后一问。
      if (file.size > MAX_READ_BYTES) this.seedHead(st, file);
    }
    let from = st.offset;
    if (file.size < from) {
      from = 0;
      st.rest = "";
    }
    if (file.size > from) {
      let start = Math.max(from, file.size - MAX_READ_BYTES);
      // 第一次只读尾部时，把起点对齐到行首：否则边界那一行会被 JSON.parse 丢掉，
      // 前缀计数和尾部计数都会漏掉它。
      if (from === 0 && start > 0) start = this.alignLineStart(file.path, start);
      const length = file.size - start;
      if (length > 0) {
        try {
          const fd = fs.openSync(file.path, "r");
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, start);
          fs.closeSync(fd);
          const text = st.rest + buf.toString("utf8");
          const lines = text.split("\n");
          st.rest = lines.pop() || "";
          for (const line of lines) this.applyLine(st, line);
          st.offset = file.size;
        } catch (error) {
          this.log.debug("读取 transcript 失败: " + error.message);
        }
      }
    }
    st.mtimeMs = file.mtimeMs;
    this.publish(st);
  }

  /** 把字节偏移向前挪到行首（最多回看 64KB）。 */
  alignLineStart(file, start) {
    if (start <= 0) return 0;
    const back = Math.min(start, 64 * 1024);
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(back);
      fs.readSync(fd, buf, 0, back, start - back);
      fs.closeSync(fd);
      const idx = buf.lastIndexOf(0x0a);
      return idx >= 0 ? start - back + idx + 1 : start;
    } catch (error) {
      return start;
    }
  }

  /** 一行里的用户提问文本；与 applyLine 的计数规则保持一致。 */
  userTurnText(line) {
    if (!line || line.indexOf('"type":"user"') === -1) return "";
    try {
      const entry = JSON.parse(line);
      return entry.type === "user" ? userText(entry) : "";
    } catch (error) {
      return "";
    }
  }

  /**
   * 只读尾部之前，把前缀里的用户轮次和最后一条用户提问补出来：
   *  - 轮次：卡片「第 N 轮」要和详情一致；
   *  - 最后提问：上下文压缩后，最后一条人类提问可能落在尾部窗口之前。
   */
  scanPrefix(file, end) {
    const result = { turns: 0, lastPrompt: "" };
    if (!(end > 0)) return result;
    let position = 0;
    let rest = "";
    const chunk = 1024 * 1024;
    try {
      const fd = fs.openSync(file, "r");
      try {
        while (position < end) {
          const length = Math.min(chunk, end - position);
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, position);
          position += length;
          const lines = (rest + buf.toString("utf8")).split("\n");
          rest = lines.pop() || "";
          for (const line of lines) {
            const text = this.userTurnText(line.trim());
            if (!text) continue;
            result.turns += 1;
            result.lastPrompt = text;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      this.log.debug("统计 transcript 前缀失败: " + error.message);
    }
    return result;
  }

  /** 大 transcript 只读尾部时，用头部 64KB 找回稳定的会话标题和第一问。 */
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
        if (entry.type === "user" && !st.firstPrompt) {
          const text = userText(entry);
          if (text) st.firstPrompt = preview(text, 200);
        }
      }
    } catch (error) {
      this.log.debug("读取 transcript 头部失败: " + error.message);
    }
    // 尾部读取会跳过前缀；前缀里的轮次和最后一条用户提问都要补上。
    const tailStart = this.alignLineStart(file.path, Math.max(0, file.size - MAX_READ_BYTES));
    const prefix = this.scanPrefix(file.path, tailStart);
    st.turns = prefix.turns;
    if (prefix.lastPrompt) {
      if (!st.firstPrompt) st.firstPrompt = preview(prefix.lastPrompt, 200);
      st.lastPrompt = prefix.lastPrompt;
      // 已经有真实提问了，后面的 last-prompt 元数据不要再来覆盖（Claude 会写回第一句）。
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
      case "last-prompt":
        // 只在还没读到真正的 user 消息时兜底，否则会把最新问题覆盖回第一句。
        if (!st.promptFromUser && entry.lastPrompt) st.lastPrompt = preview(entry.lastPrompt, 300);
        break;
      case "permission-mode":
        st.permissionMode = entry.permissionMode;
        break;
      case "user": {
        // Qoder CN 没有独立的 permission-mode 条目，权限模式挂在 user 条目上。
        if (typeof entry.permissionMode === "string" && entry.permissionMode) {
          st.permissionMode = entry.permissionMode;
        }
        // 只有「真正的用户提问」才算一轮：tool_result / isMeta / isSidechain 都不算。
        // 这样手机卡片上的轮次和「查看完整」里的轮次是同一种计数。
        const promptText = userText(entry);
        const isTurn = !!promptText;
        if (isTurn) st.turns += 1;
        // Claude Code 的 last-prompt 记录会重复写第一次的 prompt（实测 2.x），
        // 所以「你说了什么」以真正的 user 消息为准，last-prompt 只作兜底。
        if (isTurn) {
          if (!st.firstPrompt) st.firstPrompt = preview(promptText, 200);
          st.lastPrompt = promptText;
          st.promptFromUser = true;
          st.turnStarted = true;
          if (st.lastEntry !== "user" || !st.activeRunId) {
            st.activeRunId = makeRunId(this.idFor(st.sessionId), st.turns || 1);
          }
        }
        st.lastEntry = "user";
        break;
      }
      case "assistant": {
        const message = entry.message || {};
        st.lastEntry = "assistant";
        st.lastStop = message.stop_reason || st.lastStop;
        const content = message.content;
        let textPart = null;
        if (Array.isArray(content)) {
          textPart = content.find((c) => c && c.type === "text" && c.text);
          if (textPart) st.lastText = truncateText(textPart.text, 12000);
        }
        // 一轮里可能先写一条空 text 的 end_turn，再写真正带回答的那条；
        // 只在带文本的 end_turn 上判定完成，避免通知里拿到空回答。
        if (st.lastStop === "end_turn" && textPart) st.turnEnded = true;
        break;
      }
      default:
        // system / attachment / ai-title / last-prompt 等元数据不是对话回合，
        // 不能覆盖 lastEntry，否则任务完成后会被误判成 idle。
        break;
    }
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
      if (entry.type === "user") {
        const prompt = userText(entry);
        if (!prompt) continue;
        current = { turn: all.length + 1, prompt, response: "" };
        all.push(current);
      } else if (entry.type === "assistant" && current) {
        const response = assistantText(entry);
        if (response) current.response = response;
      }
    }
    return {
      turns: all.slice(-limit),
      truncated: all.length > limit,
      total: all.length,
    };
  }

  deriveStatus(st) {
    const fresh = Date.now() - st.mtimeMs < this.activeMs;
    if (st.lastStop === "end_turn" && st.lastEntry === "assistant") return TASK.COMPLETED;
    if (st.lastEntry === "assistant" && st.lastStop === "tool_use") return TASK.WORKING;
    if (st.lastEntry === "user" && fresh) return TASK.WORKING;
    if (fresh) return TASK.WORKING;
    return IDLE;
  }

  publish(st) {
    const firstScan = st.status === null;
    const status = this.deriveStatus(st);
    const prev = st.status;
    // 用户消息和回答可能落在同一次轮询里（快任务），不能只看最终 status 变化。
    const started = st.turnStarted && !firstScan;
    const ended = st.turnEnded && !firstScan;
    // 适配器启动时 Claude 可能正跑到一半：把「working」视为已有一轮在跑，
    // 这样它结束时仍会发完成通知，而不是因为没看见开始就永远沉默。
    if (firstScan && status === TASK.WORKING) {
      st.runActive = true;
      if (!st.activeRunId) st.activeRunId = makeRunId(this.idFor(st.sessionId), st.turns || 1);
    }
    st.turnStarted = false;
    st.turnEnded = false;
    st.status = status;
    // 标题可能晚于 transcript 到达（例如 Qoder CN 的 AI 标题写进 SQLite），
    // 所以标题变化也要重新发布一次。
    const title = this.titleFor(st);
    if (prev === status && st.publishedMtime === st.mtimeMs && st.publishedTitle === title) return;
    st.publishedMtime = st.mtimeMs;
    st.publishedTitle = title;
    const record = {
      id: this.idFor(st.sessionId),
      sessionId: this.idFor(st.sessionId),
      agent: this.name,
      agentLabel: this.agentLabel,
      capabilities: this.profile.capabilities || null,
      // 会话名保持稳定：优先厂商标题，其次第一问；最新一问只放在 lastPrompt。
      title,
      cwd: st.cwd,
      status,
      running: status === TASK.WORKING,
      runId: st.activeRunId || null,
      updatedAt: st.mtimeMs,
      lastPrompt: st.lastPrompt,
      lastResponse: st.lastText,
      turns: st.turns,
      pending: [],
      detail: { permissionMode: st.permissionMode || null, transcript: path.basename(st.path || "") },
    };
    this.hub.emit(EVENT.SESSION_UPSERT, record);
    if (started && this.runEnd !== "none") {
      st.runActive = true;
      st.runId = st.activeRunId || makeRunId(record.sessionId, st.turns || 1);
      this.hub.emit(EVENT.RUN_STARTED, {
        runId: st.runId,
        sessionId: record.sessionId,
        agent: this.name,
        agentLabel: record.agentLabel,
        title: record.title,
        sessionTitle: record.title,
        startedAt: Date.now(),
      });
    }
    if (ended && st.runActive && this.runEnd !== "none") {
      st.runActive = false;
      const runId = st.runId || st.activeRunId || makeRunId(record.sessionId, st.turns || 1);
      st.activeRunId = null;
      st.runId = null;
      this.hub.emit(EVENT.RUN_COMPLETED, {
        runId,
        sessionId: record.sessionId,
        agent: this.name,
        agentLabel: record.agentLabel,
        title: record.title,
        sessionTitle: record.title,
        text: record.lastResponse,
        finishedAt: Date.now(),
      });
    }
  }
}
