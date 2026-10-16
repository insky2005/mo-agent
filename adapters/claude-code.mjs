import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EVENT } from "../core/events.mjs";
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
    this.root = expandHome((this.profile.session && this.profile.session.root) || "~/.claude/projects");
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
      this.hub.emit(EVENT.AGENT_REMOVED, { id: st.sessionId, agent: this.name });
    }
  }

  ingest(file) {
    let st = this.sessions.get(file.path);
    if (!st) {
      st = { sessionId: path.basename(file.path, ".jsonl"), offset: 0, rest: "", lastEntry: null, lastStop: null, lastText: "", cwd: "", title: "", lastPrompt: "", turns: 0, status: null, updatedAt: file.mtimeMs };
      this.sessions.set(file.path, st);
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
        if (entry.lastPrompt) st.lastPrompt = preview(entry.lastPrompt, 300);
        break;
      case "permission-mode":
        st.permissionMode = entry.permissionMode;
        break;
      case "user": {
        const content = entry.message && entry.message.content;
        const isToolResult = Array.isArray(content) && content.some((c) => c && c.type === "tool_result");
        if (!isToolResult) st.turns += 1;
        st.lastEntry = "user";
        break;
      }
      case "assistant": {
        const message = entry.message || {};
        st.lastEntry = "assistant";
        st.lastStop = message.stop_reason || st.lastStop;
        const content = message.content;
        if (Array.isArray(content)) {
          const textPart = content.find((c) => c && c.type === "text" && c.text);
          if (textPart) st.lastText = preview(textPart.text, 600);
        }
        break;
      }
      default:
        st.lastEntry = entry.type || st.lastEntry;
        break;
    }
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
    const status = this.deriveStatus(st);
    const prev = st.status;
    st.status = status;
    if (prev === status && st.publishedMtime === st.mtimeMs) return;
    st.publishedMtime = st.mtimeMs;
    const record = {
      id: "claude-code:" + st.sessionId,
      sessionId: "claude-code:" + st.sessionId,
      agent: this.name,
      title: st.title || st.lastPrompt || "Claude Code 会话",
      cwd: st.cwd,
      status,
      running: status === TASK.WORKING,
      updatedAt: st.mtimeMs,
      lastPrompt: st.lastPrompt,
      lastResponse: st.lastText,
      turns: st.turns,
      pending: [],
      detail: { permissionMode: st.permissionMode || null, transcript: path.basename(st.path || "") },
    };
    this.hub.emit(EVENT.AGENT_UPDATED, record);
    if (prev && prev !== status) {
      if (status === TASK.COMPLETED) {
        this.hub.emit(EVENT.RUN_COMPLETED, { id: record.id, agent: this.name, title: record.title, text: record.lastResponse });
      } else if (status === TASK.WORKING && prev !== TASK.WORKING) {
        this.hub.emit(EVENT.RUN_STARTED, { id: record.id, agent: this.name, title: record.title });
      }
    }
  }
}
