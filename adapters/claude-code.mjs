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

function preview(text, max) {
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
  if (!entry || entry.isMeta || entry.isSidechain) return "";
  const content = entry.message && entry.message.content;
  const blocks = Array.isArray(content) ? content : [];
  if (blocks.some((c) => c && c.type === "tool_result")) return "";
  const text = typeof content === "string"
    ? content
    : blocks.filter((c) => c && c.type === "text" && c.text).map((c) => c.text).join(" ");
  return text && text.trim() ? truncateText(text, 4000) : "";
}

/**
 * Claude Code 观测适配器（L2：transcript 层）。
 * 它只能回答「在跑 / 干完了 / 停了」；「在等授权」必须靠 PermissionRequest hook。
 * 这个边界是设计的一部分，不是缺陷。
 */
export class ClaudeCodeAdapter {
  constructor(options) {
    const opts = options || {};
    this.name = "claude-code";
    this.hub = opts.hub;
    this.log = opts.log || (() => {});
    this.profile = opts.profile || {};
    // runEnd: explicit | inferred | none；none 时只更新状态，不发完成信号。
    this.runEnd = (this.profile.capabilities && this.profile.capabilities.runEnd) || "explicit";
    // 测试/诊断可以指向别处，避免本机真实 transcript 污染集成测试。
    this.root = expandHome(
      process.env.MO_AGENT_CLAUDE_ROOT
      || (this.profile.session && this.profile.session.root)
      || "~/.claude/projects"
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
      this.log.warn("Claude Code 目录不存在，适配器跳过: " + this.root);
      return;
    }
    this.log.info("Claude Code 适配器已启动，监听 " + this.root);
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listFiles() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (error) {
      return out;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const full = path.join(this.root, dir.name);
      let files = [];
      try {
        files = fs.readdirSync(full, { withFileTypes: true });
      } catch (error) {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const p = path.join(full, file.name);
        let stat;
        try {
          stat = fs.statSync(p);
        } catch (error) {
          continue;
        }
        if (Date.now() - stat.mtimeMs > this.activeWindowMs) continue;
        out.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs });
      }
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
      this.log.debug("Claude Code 轮询失败: " + error.message);
    } finally {
      this.busy = false;
    }
  }

  poll() {
    const files = this.listFiles();
    const seen = new Set();
    for (const file of files) {
      seen.add(file.path);
      this.ingest(file);
    }
    for (const [p, st] of [...this.sessions]) {
      if (seen.has(p)) continue;
      this.sessions.delete(p);
      const sessionId = "claude-code:" + st.sessionId;
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
      const start = Math.max(from, file.size - MAX_READ_BYTES);
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
        const content = entry.message && entry.message.content;
        const blocks = Array.isArray(content) ? content : [];
        const isToolResult = blocks.some((c) => c && c.type === "tool_result");
        if (!isToolResult) st.turns += 1;
        // Claude Code 的 last-prompt 记录会重复写第一次的 prompt（实测 2.x），
        // 所以「你说了什么」以真正的 user 消息为准，last-prompt 只作兜底。
        if (!isToolResult && !entry.isMeta && !entry.isSidechain) {
          const text = userText(entry);
          if (text) {
            if (!st.firstPrompt) st.firstPrompt = preview(text, 200);
            st.lastPrompt = text;
            st.promptFromUser = true;
          }
        }
        if (!isToolResult) {
          st.turnStarted = true;
          if (st.lastEntry !== "user" || !st.activeRunId) {
            st.activeRunId = makeRunId("claude-code:" + st.sessionId, st.turns || 1);
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
    const st = [...this.sessions.values()].find((item) => "claude-code:" + item.sessionId === sessionId);
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
      if (!st.activeRunId) st.activeRunId = makeRunId("claude-code:" + st.sessionId, st.turns || 1);
    }
    st.turnStarted = false;
    st.turnEnded = false;
    st.status = status;
    if (prev === status && st.publishedMtime === st.mtimeMs) return;
    st.publishedMtime = st.mtimeMs;
    const record = {
      id: "claude-code:" + st.sessionId,
      sessionId: "claude-code:" + st.sessionId,
      agent: this.name,
      agentLabel: (this.profile && this.profile.label) || "Claude Code",
      capabilities: this.profile.capabilities || null,
      // 会话名保持稳定：优先 Claude 生成的标题，其次第一问；最新一问只放在 lastPrompt。
      title: st.title || st.firstPrompt || st.lastPrompt || "Claude Code 会话",
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
