import fs from "node:fs";
import path from "node:path";
import { EVENT, makeRunId } from "../core/contract.mjs";
import { TASK, IDLE } from "../core/status.mjs";
import { TranscriptAdapter, preview } from "./transcript-adapter.mjs";

/**
 * Pi 会话观测适配器（L2：transcript 层）。
 *
 * Pi 的 JSONL 和 Claude Code 不同构：
 *   - 第一行是 { type:"session", id, cwd, version }
 *   - 对话条目统一是 { type:"message", message:{ role, content, stopReason } }
 *   - 树形结构：id / parentId，/tree 会产生分支
 * 所以不能直接复用 TranscriptAdapter 的 applyLine，只复用它的读文件、前缀扫描和发布骨架。
 *
 * 只做观测：授权请求不在这一层（Pi 本身没有原生工具审批）。
 */
export class PiAdapter extends TranscriptAdapter {
  constructor(options) {
    const opts = options || {};
    super(Object.assign({}, opts, {
      name: "pi",
      prefix: "pi:",
      rootEnv: "MO_AGENT_PI_ROOT",
      defaultRoot: "~/.pi/agent/sessions",
      defaultLabel: "Pi",
      defaultTitle: "Pi 会话",
    }));
    this.control = opts.control || null;
  }

  labelFor() {
    return this.agentLabel;
  }

  titleFor(st) {
    return preview(st.sessionName || st.title || st.firstPrompt || st.lastPrompt || this.defaultTitle, 60);
  }

  /** 控制扩展在线时才把 prompt/cancel 能力暴露给 UI；离线时保持只读。 */
  capabilitiesFor(st) {
    const caps = Object.assign({}, this.profile.capabilities || {});
    const online = !!this.control
      && typeof this.control.isOnline === "function"
      && this.control.isOnline(this.idFor(st.sessionId));
    caps.control = online ? ["prompt", "cancel"] : [];
    return caps;
  }

  /** 前缀扫描（大文件只看尾部时用来补轮次/最后提问）。 */
  userTurnText(line) {
    if (!line || line.indexOf('"type":"message"') === -1) return "";
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || !entry.message || entry.message.role !== "user") return "";
      return messageText(entry.message, 4000);
    } catch (error) {
      return "";
    }
  }

  /** 大文件只读尾部时，用头部 64KB 找回 sessionId / cwd / 会话名 / 第一问。 */
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
        if (entry.type === "session") {
          if (entry.id) st.sessionId = entry.id;
          if (entry.cwd) st.cwd = entry.cwd;
        } else if (entry.type === "session_info" && entry.name) {
          st.sessionName = entry.name;
        } else if (entry.type === "message" && entry.message && entry.message.role === "user") {
          const text = messageText(entry.message, 4000);
          if (text && !st.firstPrompt) st.firstPrompt = preview(text, 200);
        }
      }
    } catch (error) {
      this.log.debug("读取 Pi 会话头部失败: " + error.message);
    }
    const tailStart = this.alignLineStart(file.path, Math.max(0, file.size - 512 * 1024));
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

    if (entry.type === "session") {
      if (entry.id) st.sessionId = entry.id;
      if (entry.cwd) st.cwd = entry.cwd;
      return;
    }
    if (entry.type === "session_info") {
      if (entry.name) st.sessionName = entry.name;
      return;
    }
    if (entry.type === "model_change") {
      if (entry.provider) st.provider = entry.provider;
      if (entry.modelId) st.model = entry.modelId;
      return;
    }
    if (entry.type !== "message" || !entry.message) return;

    const message = entry.message;
    const role = message.role;

    if (role === "user") {
      const promptText = messageText(message, 4000);
      if (!promptText) return;
      st.turns = (st.turns || 0) + 1;
      st.lastText = "";
      st.lastStop = null;
      st.lastOutcome = null;
      st.lastError = "";
      st.lastEntry = "user";
      st.turnStarted = true;
      st.turnEnded = false;
      if (!st.firstPrompt) st.firstPrompt = preview(promptText, 200);
      st.lastPrompt = promptText;
      st.promptFromUser = true;
      st.activeRunId = makeRunId(this.idFor(st.sessionId), st.turns || 1);
      return;
    }

    if (role === "assistant") {
      const text = messageText(message, 12000);
      if (text) st.lastText = text;
      if (message.provider) st.provider = message.provider;
      if (message.model) st.model = message.model;
      st.lastEntry = "assistant";
      st.lastStop = message.stopReason || st.lastStop || null;
      if (!st.lastError && message.errorMessage) st.lastError = message.errorMessage;
      if (isTerminal(st.lastStop)) {
        st.turnEnded = true;
        st.turnOutcome = outcomeFor(st.lastStop);
        st.lastOutcome = st.turnOutcome;
      }
      return;
    }

    if (role === "toolResult") {
      st.lastEntry = "toolResult";
      return;
    }

    // system / custom / bashExecution 等不参与轮次，也不覆盖 lastEntry。
  }

  deriveStatus(st) {
    const fresh = Date.now() - st.mtimeMs < this.activeMs;
    if (st.lastEntry === "assistant") {
      if (st.lastStop === "toolUse") return TASK.WORKING;
      if (st.lastStop === "error") return TASK.FAILED;
      if (st.lastStop === "aborted") return TASK.CANCELED;
      if (st.lastStop === "stop" || st.lastStop === "length") return TASK.COMPLETED;
    }
    if (st.lastEntry === "toolResult") return TASK.WORKING;
    if (st.lastEntry === "user" && fresh) return TASK.WORKING;
    if (fresh && st.lastEntry) return TASK.WORKING;
    return IDLE;
  }

  publish(st) {
    const firstScan = st.status === null;
    const status = this.deriveStatus(st);
    const prev = st.status;
    const started = st.turnStarted && !firstScan;
    const ended = st.turnEnded && !firstScan;

    if (firstScan && status === TASK.WORKING) {
      st.runActive = true;
      if (!st.activeRunId) st.activeRunId = makeRunId(this.idFor(st.sessionId), st.turns || 1);
    }

    st.turnStarted = false;
    st.turnEnded = false;
    st.status = status;

    const title = this.titleFor(st);
    if (prev === status && st.publishedMtime === st.mtimeMs && st.publishedTitle === title) return;
    st.publishedMtime = st.mtimeMs;
    st.publishedTitle = title;

    const sessionId = this.idFor(st.sessionId);
    const record = {
      id: sessionId,
      sessionId,
      agent: this.name,
      agentLabel: this.labelFor(st),
      capabilities: this.capabilitiesFor(st),
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
      detail: {
        transcript: path.basename(st.path || ""),
        model: st.model || null,
        provider: st.provider || null,
      },
    };
    this.hub.emit(EVENT.SESSION_UPSERT, record);

    if (started && this.runEnd !== "none") {
      st.runActive = true;
      st.runId = st.activeRunId || makeRunId(sessionId, st.turns || 1);
      this.hub.emit(EVENT.RUN_STARTED, {
        runId: st.runId,
        sessionId,
        agent: this.name,
        agentLabel: record.agentLabel,
        title: record.title,
        sessionTitle: record.title,
        startedAt: Date.now(),
      });
    }

    if (ended && st.runActive && this.runEnd !== "none") {
      st.runActive = false;
      const runId = st.runId || st.activeRunId || makeRunId(sessionId, st.turns || 1);
      const outcome = st.turnOutcome || "completed";
      const payload = {
        runId,
        sessionId,
        agent: this.name,
        agentLabel: record.agentLabel,
        title: record.title,
        sessionTitle: record.title,
        text: record.lastResponse,
        error: st.lastError || "",
        finishedAt: Date.now(),
      };
      st.turnOutcome = null;
      st.activeRunId = null;
      st.runId = null;
      this.hub.emit(
        outcome === "failed" ? EVENT.RUN_FAILED : outcome === "canceled" ? EVENT.RUN_CANCELED : EVENT.RUN_COMPLETED,
        payload
      );
    }
  }

  /** 按当前活动分支还原历史；分支里被放弃的消息不能算进轮次。 */
  history(sessionId, options) {
    const limit = Math.min(50, Math.max(1, Number(options && options.limit) || 20));
    const st = [...this.sessions.values()].find((item) => this.idFor(item.sessionId) === sessionId);
    if (!st || !st.path) return { turns: [], truncated: false, total: 0 };

    let entries = [];
    try {
      entries = fs.readFileSync(st.path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (error) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (error) {
      return { turns: [], truncated: false, total: 0 };
    }

    const byId = new Map(entries.filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
    const leaf = entries[entries.length - 1];
    let branch = entries;
    if (leaf && leaf.id && byId.size) {
      const chain = [];
      let cursor = leaf;
      const seen = new Set();
      while (cursor && cursor.id && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        chain.push(cursor);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
      }
      if (chain.length) branch = chain.reverse();
    }

    const all = [];
    let current = null;
    for (const entry of branch) {
      if (entry.type !== "message" || !entry.message) continue;
      const role = entry.message.role;
      if (role === "user") {
        const prompt = messageText(entry.message, 4000);
        if (!prompt) continue;
        current = { turn: all.length + 1, prompt, response: "" };
        all.push(current);
      } else if (role === "assistant" && current) {
        const response = messageText(entry.message, 12000);
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

function isTerminal(stopReason) {
  return stopReason === "stop" || stopReason === "length" || stopReason === "error" || stopReason === "aborted";
}

function outcomeFor(stopReason) {
  if (stopReason === "error") return "failed";
  if (stopReason === "aborted") return "canceled";
  return "completed";
}

function messageText(message, max) {
  const content = message && message.content;
  if (typeof content === "string") return truncateText(content, max);
  if (!Array.isArray(content)) return "";
  return truncateText(
    content.filter((part) => part && part.type === "text" && part.text).map((part) => part.text).join("\n"),
    max
  );
}

function truncateText(text, max) {
  const value = String(text == null ? "" : text).trim();
  const limit = max || 4000;
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}
