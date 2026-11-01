(function () {
  "use strict";

  var AGENT_LABELS = {
    dsh: "DeepSeek Harness",
    "claude-code": "Claude Code",
    "qoder-cn": "Qoder CN",
    workbuddy: "WorkBuddy",
    pi: "Pi",
  };
  var STATUS = {
    submitted: { label: "已提交", cls: "running" },
    working: { label: "运行中", cls: "running" },
    "input-required": { label: "等待回答", cls: "waiting" },
    "auth-required": { label: "等待授权", cls: "waiting" },
    completed: { label: "已完成", cls: "completed" },
    canceled: { label: "已中断", cls: "completed" },
    failed: { label: "失败", cls: "error" },
    rejected: { label: "已拒绝", cls: "error" },
    idle: { label: "空闲", cls: "idle" },
  };
  var EVENT_KIND = {
    "session.upsert": "state",
    "session.removed": "state",
    "run.started": "running",
    "run.completed": "done",
    "run.failed": "error",
    "run.canceled": "done",
    "pending.added": "waiting",
    "pending.resolved": "state",
    "approval.pending": "waiting",
    "approval.resolved": "state",
    "source.error": "error",
    "notice": "waiting",
    "notify": "state",
  };

  var state = {
    sessions: new Map(),
    approvals: new Map(),
    questions: new Map(),
    sources: [],
    sourceErrors: new Map(),
    processes: [],
    clients: 0,
    monitor: null,
    dingtalk: null,
    seq: 0,
    startedAt: 0,
    receivedSnapshot: false,
    connected: false,
    paused: false,
    filter: "all",
    search: "",
    selected: "",
    runningSince: new Map(),
    events: [],
    lastConnectionText: "连接中",
    lastConnectionClass: "connecting",
    stream: null,
    pollTimer: null,
    snapshotTimer: null,
    loadFailures: 0,
  };

  function $(id) { return document.getElementById(id); }
  var dom = {
    sources: $("sources"),
    clock: $("clock"),
    uptime: $("uptime"),
    conn: $("conn"),
    btnSettings: $("btnSettings"),
    btnPause: $("btnPause"),
    banner: $("banner"),
    stats: $("stats"),
    statRunning: $("statRunning"),
    statWaiting: $("statWaiting"),
    statError: $("statError"),
    statCompleted: $("statCompleted"),
    statIdle: $("statIdle"),
    filters: $("filters"),
    search: $("search"),
    sessionCount: $("sessionCount"),
    sessionList: $("sessionList"),
    pendingList: $("pendingList"),
    pendingCount: $("pendingCount"),
    eventList: $("eventList"),
    liveTag: $("liveTag"),
    clients: $("clients"),
    processCount: $("processCount"),
    sourceCount: $("sourceCount"),
    monitorNote: $("monitorNote"),
    dtState: $("dtState"),
    dtBar: $("dtBar"),
    dtBind: $("dtBind"),
    dtLocal: $("dtLocal"),
    dtUsage: $("dtUsage"),
    dtToday: $("dtToday"),
    dtFail: $("dtFail"),
    dtDir: $("dtDir"),
    dtTop: $("dtTop"),
    dtDetailBtn: $("dtDetailBtn"),
    dtScrim: $("dtScrim"),
    dtDrawer: $("dtDrawer"),
    dtDrawerBody: $("dtDrawerBody"),
    btnDtDrawerClose: $("btnDtDrawerClose"),
    scrim: $("scrim"),
    drawer: $("drawer"),
    drawerTitle: $("drawerTitle"),
    drawerBody: $("drawerBody"),
    btnDrawerClose: $("btnDrawerClose"),
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clip(value, max) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    var limit = max || 120;
    return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  }

  function pad(value) { return value < 10 ? "0" + value : String(value); }

  function fmtDuration(ms) {
    var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
  }

  function ago(ts) {
    if (!ts) return "";
    var delta = Date.now() - Number(ts);
    if (delta < 3000) return "刚刚";
    if (delta < 60000) return Math.max(1, Math.round(delta / 1000)) + " 秒前";
    if (delta < 3600000) return Math.round(delta / 60000) + " 分钟前";
    if (delta < 86400000) return Math.round(delta / 3600000) + " 小时前";
    return Math.round(delta / 86400000) + " 天前";
  }

  function clockText(ts) {
    var date = new Date(ts || Date.now());
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  function fmtNum(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return "";
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "m";
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
  }

  function displayPath(value) {
    var text = String(value || "");
    if (!text) return "";
    text = text
      .replace(/^\/Users\/[^/]+\//, "~/")
      .replace(/^\/home\/[^/]+\//, "~/")
      .replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, "~\\");
    if (text.length <= 48) return text;
    var sep = text.indexOf("\\") !== -1 && text.indexOf("/") === -1 ? "\\" : "/";
    var prefix = text.indexOf("~/") === 0 ? "~/" : (text.indexOf("~\\") === 0 ? "~\\" : (text.indexOf("/") === 0 ? "/" : ""));
    var parts = text.slice(prefix.length).split(/[\\/]/).filter(Boolean);
    if (!parts.length) return text;
    var last = parts[parts.length - 1];
    for (var keep = parts.length - 1; keep >= 1; keep -= 1) {
      var candidate = prefix + parts.slice(0, keep).join(sep) + sep + "…" + sep + last;
      if (candidate.length <= 48) return candidate;
    }
    return "…" + sep + last;
  }

  function agentName(session) {
    if (!session) return "Agent";
    return session.agentLabel || AGENT_LABELS[session.agent] || session.agent || "Agent";
  }

  function agentClass(session) {
    if (!session) return "";
    if (session.agent === "dsh") return "dsh";
    if (session.agent === "claude-code") return "claude";
    if (session.agent === "qoder-cn") return "qoder";
    if (session.agent === "workbuddy") return "workbuddy";
    if (session.agent === "pi") return "pi";
    return "";
  }

  function statusInfo(session) {
    if (!session) return STATUS.idle;
    if (session.running && !STATUS[session.status]) return STATUS.working;
    return STATUS[session.status] || STATUS.idle;
  }

  function statusClass(session) {
    var info = statusInfo(session);
    if (session && session.running && info.cls === "idle") return "running";
    return info.cls;
  }

  function isPending(session) {
    return !!(session && session.pending && session.pending.length);
  }

  /**
   * 「活跃」与手机端「只看活跃」保持一致：
   * 运行中 / 有待处理请求 / 当前选中，或最近 6 小时内更新过；
   * 不在运行的分支只是历史，不算活跃。
   */
  function isActiveSession(session) {
    if (!session) return false;
    if (session.running || isPending(session)) return true;
    if (state.selected === session.sessionId) return true;
    if (session.parentId) return false;
    return Date.now() - (Number(session.updatedAt) || 0) < 6 * 3600 * 1000;
  }

  function tokenTotal(session) {
    var usage = session && session.tokenUsage;
    if (usage == null) return null;
    if (typeof usage === "number") return usage;
    if (typeof usage !== "object") return null;
    var keys = ["totalTokens", "total_tokens", "total", "tokens"];
    for (var i = 0; i < keys.length; i += 1) {
      if (Number.isFinite(Number(usage[keys[i]]))) return Number(usage[keys[i]]);
    }
    if (Number.isFinite(Number(usage.inputTokens)) && Number.isFinite(Number(usage.outputTokens))) {
      return Number(usage.inputTokens) + Number(usage.outputTokens);
    }
    if (Number.isFinite(Number(usage.input)) && Number.isFinite(Number(usage.output))) {
      return Number(usage.input) + Number(usage.output);
    }
    return null;
  }

  function trackRunning(next, prev) {
    if (!next || !next.sessionId) return;
    var running = !!next.running || statusClass(next) === "running";
    if (running) {
      if (!state.runningSince.has(next.sessionId) || (prev && !prev.running)) {
        state.runningSince.set(next.sessionId, Date.now());
      }
    } else {
      state.runningSince.delete(next.sessionId);
    }
  }

  function runDuration(id) {
    var since = state.runningSince.get(id);
    return since ? Date.now() - since : 0;
  }

  // ---------------------------------------------------------------- 事件流

  function addEvent(kind, title, sub, at) {
    state.events.unshift({
      kind: kind || "state",
      title: title || "",
      sub: sub || "",
      at: at || Date.now(),
    });
    if (state.events.length > 80) state.events.length = 80;
  }

  function renderEvents() {
    if (!state.events.length) {
      dom.eventList.innerHTML = '<div class="emptyMini">等待事件…</div>';
      return;
    }
    dom.eventList.innerHTML = state.events.map(function (event) {
      return '<div class="eventItem">'
        + '<span class="eventDot ' + esc(event.kind) + '"></span>'
        + '<div class="eventBody"><div class="eventTitle">' + event.title + '</div>'
        + (event.sub ? '<div class="eventSub">' + event.sub + '</div>' : "")
        + '</div><span class="eventTime" data-ago="' + event.at + '">' + ago(event.at) + '</span></div>';
    }).join("");
  }

  // ---------------------------------------------------------------- 状态应用

  function setConn(label, cls) {
    state.lastConnectionText = label;
    state.lastConnectionClass = cls;
    dom.conn.className = "conn " + cls;
    dom.conn.innerHTML = "<i></i><span>" + esc(label) + "</span>";
    dom.liveTag.className = "liveTag" + (cls === "on" ? "" : " off");
  }

  function setSources(sources, errors) {
    state.sources = Array.isArray(sources) ? sources.slice() : [];
    if (Array.isArray(errors)) {
      var map = new Map();
      errors.forEach(function (item) {
        if (item && item.source) map.set(item.source, item);
      });
      state.sourceErrors = map;
    }
    renderSources();
  }

  function sourceClass(agent) {
    if (agent === "dsh") return "dsh";
    if (agent === "claude-code") return "claude";
    if (agent === "qoder-cn") return "qoder";
    if (agent === "workbuddy") return "workbuddy";
    if (agent === "pi") return "pi";
    return "";
  }

  /**
   * 数据源以 adapter 为主；同一个 adapter 可能有多个运行面
   * （例如 Qoder CN 桌面端和 Qoder CN IDE 共用 qoder-cn），
   * 后者从会话的 agentLabel 里补出来，避免只显示一个 Qoder CN。
   */
  function sourceEntries() {
    var variants = new Map();
    var counts = new Map();
    state.sessions.forEach(function (session) {
      if (!session || !session.agent) return;
      var label = session.agentLabel || AGENT_LABELS[session.agent] || session.agent;
      var sessionKey = session.agent + "::" + label;
      counts.set(sessionKey, (counts.get(sessionKey) || 0) + 1);
      var base = AGENT_LABELS[session.agent] || session.agent;
      if (label === base) return;
      if (!variants.has(session.agent)) variants.set(session.agent, new Set());
      variants.get(session.agent).add(label);
    });

    var entries = [];
    var seen = new Set();
    function add(agent, label, variant) {
      var key = agent + "::" + label;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ agent: agent, label: label, variant: !!variant, count: counts.get(key) || 0 });
    }
    state.sources.forEach(function (agent) {
      add(agent, AGENT_LABELS[agent] || agent, false);
      var extra = variants.get(agent);
      if (extra) extra.forEach(function (label) { add(agent, label, true); });
    });
    // 会话里出现、但 adapter 列表里没有的来源也补上，避免状态丢了。
    variants.forEach(function (labels, agent) {
      labels.forEach(function (label) { add(agent, label, true); });
    });
    return entries;
  }

  function renderSources() {
    var entries = sourceEntries();
    dom.sourceCount.textContent = String(entries.length);
    if (!entries.length) {
      dom.sources.innerHTML = '<div class="emptyMini">无数据源</div>';
      return;
    }
    dom.sources.innerHTML = entries.map(function (entry) {
      var error = state.sourceErrors.get(entry.agent);
      var title = error
        ? (entry.label + " · 数据源异常：" + error.message)
        : (entry.label + " · 数据源正常");
      return '<span class="sourceChip ' + sourceClass(entry.agent) + (entry.variant ? " variant" : "") + (error ? " bad" : "") + '" title="' + esc(title + " · " + entry.count + " 个会话") + '">'
        + '<i class="sourceDot"></i><span class="sourceName">' + esc(entry.label) + '</span>'
        + '<span class="sourceSessions">' + entry.count + '</span></span>';
    }).join("");
  }

  function applySnapshot(data) {
    if (!data || !data.ok) return;
    state.sessions = new Map();
    (data.sessions || []).forEach(function (session) {
      if (!session || !session.sessionId) return;
      state.sessions.set(session.sessionId, session);
      trackRunning(session, null);
    });
    state.approvals = new Map();
    ((data.pending && data.pending.approvals) || []).forEach(function (item) {
      if (item && item.id) state.approvals.set(item.id, item);
    });
    state.questions = new Map();
    ((data.pending && data.pending.questions) || []).forEach(function (item) {
      if (item && item.eventId) state.questions.set(item.eventId, item);
    });
    state.processes = data.processes || [];
    state.clients = Number(data.clients) || 0;
    state.monitor = data.monitor || null;
    state.dingtalk = data.dingtalk || null;
    state.seq = Number(data.seq) || state.seq;
    state.startedAt = Number(data.startedAt) || state.startedAt;
    setSources(data.sources, data.sourceErrors);
    var first = !state.receivedSnapshot;
    state.receivedSnapshot = true;
    if (first) {
      addEvent("done", "监控屏已连接", "本地服务 · 共 " + state.sessions.size + " 个会话");
    }
    if (!state.paused) renderAll();
  }

  /**
   * 轻量刷新：SSE 正常时只更新钉钉、进程、数据源这类快照字段，
   * 不动会话列表/事件列表，避免定时轮询把用户的滚动位置顶回顶部。
   */
  function applyLightSnapshot(data) {
    if (!data || !data.ok) return;
    state.processes = data.processes || [];
    state.clients = Number(data.clients) || 0;
    state.monitor = data.monitor || null;
    state.dingtalk = data.dingtalk || null;
    state.startedAt = Number(data.startedAt) || state.startedAt;
    setSources(data.sources, data.sourceErrors);
    if (state.paused) return;
    renderSources();
    renderDingtalk();
    if (dom.dtDrawer && !dom.dtDrawer.classList.contains("hidden")) renderDtDrawer();
    renderFooter();
  }

  function handleEvent(event) {
    if (!event || typeof event.type !== "string") return;
    if (typeof event.seq === "number" && event.seq > state.seq) state.seq = event.seq;
    var payload = event.payload || {};
    var type = event.type;

    if (type === "session.upsert") {
      var id = payload.sessionId || payload.id;
      if (!id) return;
      var prev = state.sessions.get(id);
      trackRunning(payload, prev);
      state.sessions.set(id, payload);
      if (!prev) {
        addEvent(statusClass(payload), "新会话：<b>" + esc(clip(payload.title || id, 50)) + "</b>", esc(agentName(payload)));
      } else if (prev.status !== payload.status) {
        addEvent(statusClass(payload), "状态变化：<b>" + esc(clip(payload.title || id, 42)) + "</b>",
          esc((STATUS[prev.status] || STATUS.idle).label + " → " + (STATUS[payload.status] || STATUS.idle).label));
      } else if (Number(payload.turns) > Number(prev.turns || 0)) {
        addEvent("running", "第 " + payload.turns + " 轮：<b>" + esc(clip(payload.title || id, 45)) + "</b>", esc(agentName(payload)));
      }
    } else if (type === "session.removed") {
      var removed = payload.sessionId || payload.id;
      if (!removed) return;
      var old = state.sessions.get(removed);
      state.sessions.delete(removed);
      state.runningSince.delete(removed);
      addEvent("state", "会话离线：<b>" + esc(clip((old && old.title) || removed, 48)) + "</b>", "");
      if (state.selected === removed) closeDetail();
    } else if (type === "pending.added") {
      if (payload.eventId) state.questions.set(payload.eventId, payload);
      addEvent("waiting", "等待回答：<b>" + esc(clip(payload.sessionTitle || "某个会话", 44)) + "</b>", esc(describePending(payload)));
    } else if (type === "pending.resolved") {
      state.questions.delete(payload.eventId);
      addEvent("state", "回答已处理", esc(payload.reason || ""));
    } else if (type === "approval.pending") {
      state.approvals.set(payload.id, payload);
      addEvent("waiting", "等待授权：<b>" + esc(clip(payload.sessionTitle || payload.agentLabel || "某个会话", 40)) + "</b>",
        esc(payload.title || payload.toolName || "需要你的授权"));
    } else if (type === "approval.resolved") {
      state.approvals.delete(payload.id);
      addEvent("state", "授权已处理", esc(payload.decision || payload.reason || ""));
    } else if (type === "run.started") {
      addEvent("running", "开始执行：<b>" + esc(clip(payload.sessionTitle || payload.title || payload.sessionId, 44)) + "</b>", esc(payload.agentLabel || ""));
    } else if (type === "run.completed") {
      addEvent("done", "任务完成：<b>" + esc(clip(payload.sessionTitle || payload.title || payload.sessionId, 40)) + "</b>", esc(clip(payload.text || "", 80)));
    } else if (type === "run.failed") {
      addEvent("error", "执行失败：<b>" + esc(clip(payload.sessionTitle || payload.title || payload.sessionId, 40)) + "</b>", esc(clip(payload.text || "", 90)));
    } else if (type === "run.canceled") {
      addEvent("done", "已中断：<b>" + esc(clip(payload.sessionTitle || payload.title || payload.sessionId, 44)) + "</b>", "");
    } else if (type === "source.error") {
      state.sourceErrors.set(payload.source || "unknown", { source: payload.source || "unknown", message: payload.message || "", at: event.at });
      renderSources();
      addEvent("error", "数据源异常：<b>" + esc(AGENT_LABELS[payload.source] || payload.source || "未知") + "</b>", esc(clip(payload.message || "", 90)));
    } else if (type === "notice") {
      addEvent("waiting", esc(clip(payload.title || "提醒", 48)), esc(clip(payload.body || "", 90)));
    } else if (type === "notify") {
      addEvent(payload.kind === "error" ? "error" : (payload.kind === "completed" ? "done" : "waiting"),
        esc(clip(payload.title || "通知", 48)), esc(clip(payload.body || "", 90)));
    }

    if (!state.paused) renderAll();
    else refreshTimes();
  }

  function describePending(payload) {
    var question = payload.question || {};
    if (question.reason) return question.reason;
    if (question.toolName) return question.toolName;
    if (Array.isArray(question.questions) && question.questions.length) {
      return question.questions.map(function (item) { return item.question || item.header || ""; }).filter(Boolean).join(" / ");
    }
    return "Agent 需要你的输入";
  }

  // ---------------------------------------------------------------- 渲染

  function summarize() {
    var summary = { total: 0, running: 0, waiting: 0, error: 0, completed: 0, idle: 0 };
    state.sessions.forEach(function (session) {
      summary.total += 1;
      var cls = statusClass(session);
      if (summary[cls] != null) summary[cls] += 1;
      else summary.idle += 1;
    });
    return summary;
  }

  function renderStats() {
    var summary = summarize();
    dom.statRunning.textContent = String(summary.running);
    dom.statWaiting.textContent = String(summary.waiting);
    dom.statError.textContent = String(summary.error);
    dom.statCompleted.textContent = String(summary.completed);
    dom.statIdle.textContent = String(summary.idle);
    dom.sessionCount.textContent = String(summary.total);
    Array.prototype.forEach.call(dom.stats.querySelectorAll(".stat"), function (button) {
      button.classList.toggle("on", button.getAttribute("data-filter") === state.filter);
    });
    Array.prototype.forEach.call(dom.filters.querySelectorAll(".filter"), function (button) {
      button.classList.toggle("on", button.getAttribute("data-filter") === state.filter);
    });
  }

  function sessionMatches(session) {
    var cls = statusClass(session);
    if (state.filter === "active") {
      if (!isActiveSession(session)) return false;
    } else if (state.filter !== "all" && state.filter !== cls) {
      return false;
    }
    if (!state.search) return true;
    var needle = state.search.toLowerCase();
    var haystack = [
      session.title,
      session.sessionId,
      session.cwd,
      session.agentLabel,
      session.lastPrompt,
      session.lastResponse,
    ].filter(Boolean).join("\n").toLowerCase();
    return haystack.indexOf(needle) >= 0;
  }

  function visibleSessions() {
    var list = [];
    state.sessions.forEach(function (session) {
      if (sessionMatches(session)) list.push(session);
    });
    // 正在跑 / 等待 / 异常的置顶；其余按最近更新排。
    // 不能把「空闲」整体压到「完成」后面：Qoder CN IDE 等会话经常是
    // idle 但刚刚更新过，压下去就会被几十条历史完成会话淹没。
    var priority = { running: 0, waiting: 1, error: 2 };
    list.sort(function (a, b) {
      var ca = statusClass(a);
      var cb = statusClass(b);
      var pa = priority[ca] != null ? priority[ca] : 3;
      var pb = priority[cb] != null ? priority[cb] : 3;
      if (pa !== pb) return pa - pb;
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });
    return list;
  }

  function renderSessions() {
    var list = visibleSessions();
    var scroll = dom.sessionList.scrollTop;
    if (!list.length) {
      if (!state.receivedSnapshot) {
        dom.sessionList.innerHTML = '<div class="emptyState"><div class="emptyIcon">◌</div>'
          + '<div class="emptyTitle">正在连接本地服务…</div>'
          + '<div class="emptySub">会话状态会实时出现在这里</div></div>';
      } else if (state.sessions.size && (state.search || state.filter !== "all")) {
        dom.sessionList.innerHTML = '<div class="emptyState"><div class="emptyIcon">⌕</div>'
          + '<div class="emptyTitle">没有匹配的会话</div>'
          + '<div class="emptySub">换个筛选条件或清空搜索试试</div></div>';
      } else if (state.processes.length) {
        dom.sessionList.innerHTML = '<div class="emptyState"><div class="emptyIcon">◇</div>'
          + '<div class="emptyTitle">暂无可显示会话</div>'
          + '<div class="emptySub">已检测到 ' + state.processes.length + ' 个 Agent 进程，等待会话状态上报</div></div>';
      } else {
        dom.sessionList.innerHTML = '<div class="emptyState"><div class="emptyIcon">◇</div>'
          + '<div class="emptyTitle">暂无活跃会话</div>'
          + '<div class="emptySub">Agent 在终端或 IDE 里运行后，会出现在这里</div></div>';
      }
      dom.sessionList.scrollTop = 0;
      return;
    }
    dom.sessionList.innerHTML = list.map(renderSession).join("");
    dom.sessionList.scrollTop = scroll;
  }

  function renderSession(session) {
    var info = statusInfo(session);
    var cls = statusClass(session);
    var title = session.title || session.sessionId;
    var pendingText = pendingLabel(session);
    var lines = [];
    if (session.lastPrompt) {
      lines.push('<div class="sessionLine"><b>你</b><span>' + esc(clip(session.lastPrompt, 160)) + '</span></div>');
    }
    if (session.lastResponse) {
      lines.push('<div class="sessionLine"><b>Agent</b><span class="answer">' + esc(clip(session.lastResponse, 180)) + '</span></div>');
    }
    var metrics = [];
    metrics.push('<span class="metric">第 <b>' + esc(session.turns || 0) + '</b> 轮</span>');
    if (session.steps) metrics.push('<span class="metric"><i></i>' + esc(session.steps) + ' 步</span>');
    var tokens = tokenTotal(session);
    if (tokens != null) metrics.push('<span class="metric"><i></i>' + esc(fmtNum(tokens)) + ' tokens</span>');
    if (cls === "running") {
      metrics.push('<span class="metric runningFor" data-runfor="' + esc(session.sessionId) + '">已运行 ' + fmtDuration(runDuration(session.sessionId)) + '</span>');
    }
    var tags = [];
    if (session.parentId) tags.push('<span class="tag branch">分支</span>');
    if (pendingText) tags.push('<span class="pendingFlag">' + esc(pendingText) + '</span>');
    return '<article class="session ' + esc(cls) + (state.selected === session.sessionId ? " selected" : "") + '" data-id="' + esc(session.sessionId) + '">'
      + '<div class="sessionBody">'
      + '<div class="sessionTop">'
      + '<span class="pill ' + esc(cls) + '">' + esc(info.label) + '</span>'
      + '<span class="agentTag ' + esc(agentClass(session)) + '">' + esc(agentName(session)) + '</span>'
      + '<h3 class="sessionTitle" title="' + esc(title) + '">' + esc(title) + '</h3>'
      + '<span class="sessionTime" data-ago="' + esc(session.updatedAt || "") + '">' + esc(ago(session.updatedAt)) + '</span>'
      + '</div>'
      + '<div class="sessionPath" title="' + esc(session.cwd || "") + '">' + esc(displayPath(session.cwd) || "无工作目录") + '</div>'
      + (lines.length ? '<div class="sessionLines">' + lines.join("") + '</div>' : "")
      + '<div class="sessionFoot">' + metrics.join("")
      + '<span class="right"></span>' + tags.join("")
      + '</div></div></article>';
  }

  function pendingLabel(session) {
    var pending = session && session.pending;
    if (!Array.isArray(pending) || !pending.length) return "";
    if (pending.some(function (item) { return item && item.kind === "approval"; })) return "等待授权";
    return "等待回答";
  }

  function pendingItems() {
    var items = [];
    state.approvals.forEach(function (item) {
      var session = item.sessionId ? state.sessions.get(item.sessionId) : null;
      items.push({
        id: item.id,
        kind: "approval",
        label: "等待授权",
        title: item.title || item.toolName || "授权请求",
        meta: [item.agentLabel || agentName(session), item.sessionTitle || (session && session.title)].filter(Boolean).join(" · "),
        body: item.toolInput ? compactInput(item.toolInput) : (item.toolName || ""),
        sessionId: item.sessionId || "",
        at: item.createdAt || 0,
      });
    });
    state.questions.forEach(function (item) {
      var session = item.sessionId ? state.sessions.get(item.sessionId) : null;
      items.push({
        id: item.eventId,
        kind: "question",
        label: "等待回答",
        title: (item.question && (item.question.reason || item.question.toolName)) || "Agent 正在询问",
        meta: [agentName(session), item.sessionTitle || (session && session.title)].filter(Boolean).join(" · "),
        body: describePending(item),
        sessionId: item.sessionId || "",
        at: item.at || 0,
      });
    });
    items.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    return items;
  }

  function compactInput(value) {
    if (value == null) return "";
    var text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return clip(text, 220);
  }

  function renderPending() {
    var items = pendingItems();
    dom.pendingCount.textContent = String(items.length);
    if (!items.length) {
      dom.pendingList.innerHTML = '<div class="emptyMini">没有等待处理的请求</div>';
      return;
    }
    dom.pendingList.innerHTML = items.map(function (item) {
      return '<div class="pendingItem" data-session="' + esc(item.sessionId) + '">'
        + '<div class="pendingTop"><span class="pendingKind">' + esc(item.label) + '</span>'
        + '<span class="pendingTitle">' + esc(clip(item.title, 60)) + '</span>'
        + '<span class="pendingMeta" data-ago="' + esc(item.at || "") + '">' + esc(item.at ? ago(item.at) : "") + '</span></div>'
        + (item.meta ? '<div class="pendingBody">' + esc(item.meta) + '</div>' : "")
        + (item.body ? '<div class="pendingBody">' + esc(item.body) + '</div>' : "")
        + '</div>';
    }).join("");
  }

  function renderFooter() {
    dom.clients.textContent = String(state.clients || 0);
    dom.processCount.textContent = String(state.processes ? state.processes.length : 0);
    if (state.monitor && state.monitor.lastError) {
      dom.monitorNote.textContent = "DSH 拉取异常：" + state.monitor.lastError;
      dom.monitorNote.style.color = "#ffadb6";
    } else {
      dom.monitorNote.textContent = "只读监控，不会代替你做决定。";
      dom.monitorNote.style.color = "";
    }
  }

  function dingtalkState(data) {
    if (!data || !data.configured) return { text: "未配置", cls: "off" };
    var binding = data.binding || {};
    if (binding.state === "pending_confirm") return { text: "待确认", cls: "warn" };
    if (binding.state === "waiting") return { text: "待绑定", cls: "warn" };
    if (data.connected && binding.state === "bound") return { text: "已连接", cls: "ok" };
    if (data.status === "reconnecting") return { text: "重连中", cls: "warn" };
    // 刚启动时 Stream 还在 connect，status 是 connecting，不能直接显示“已断开”。
    if (data.status === "connecting" || data.connected) return { text: "连接中", cls: "warn" };
    if (data.status === "stopped") return { text: "已停止", cls: "off" };
    return { text: "已断开", cls: "bad" };
  }

  function renderDingtalk() {
    var data = state.dingtalk;
    if (!dom.dtState) return;
    if (!data) {
      dom.dtState.textContent = "未配置";
      dom.dtState.className = "connTag off";
      dom.dtBar.style.width = "0%";
      dom.dtBar.className = "";
      dom.dtBind.textContent = "未绑定";
      dom.dtLocal.textContent = "0";
      dom.dtUsage.textContent = "0 / 3000";
      dom.dtToday.textContent = "0";
      dom.dtFail.textContent = "0 / 0";
      dom.dtDir.textContent = "0 / 0";
      dom.dtTop.textContent = "—";
      return;
    }

    var binding = data.binding || {};
    var usage = data.usage || {};
    var local = usage.local || {};
    var bill = usage.billable || {};
    var stateInfo = dingtalkState(data);
    dom.dtState.textContent = stateInfo.text;
    dom.dtState.className = "connTag " + stateInfo.cls;

    var bindText = "未绑定";
    if (binding.state === "waiting") bindText = "等待首条消息";
    else if (binding.state === "pending_confirm") bindText = "待确认" + (binding.pendingNick ? " · " + binding.pendingNick : "");
    else if (binding.state === "bound") bindText = binding.userId || "已绑定";
    dom.dtBind.textContent = bindText;

    var percent = Number(bill.percent) || 0;
    dom.dtBar.style.width = Math.min(100, Math.round(percent * 100)) + "%";
    dom.dtBar.className = percent >= 1 ? "bad" : (percent >= 0.8 ? "warn" : "");

    dom.dtLocal.textContent = fmtNum(local.total || 0);
    dom.dtUsage.textContent = fmtNum(bill.total || 0) + " / " + fmtNum(bill.limit || 0);
    dom.dtToday.textContent = fmtNum(local.today || 0);
    dom.dtFail.textContent = (local.fail || 0) + " / " + (local.retries || 0);
    var direction = bill.byDirection || {};
    dom.dtDir.textContent = (direction.in || 0) + " / " + (direction.out || 0);

    var byApi = local.byApi || {};
    var top = Object.keys(byApi).sort(function (a, b) { return byApi[b] - byApi[a]; }).slice(0, 2);
    dom.dtTop.textContent = top.length
      ? top.map(function (key) { return key.split("/").pop() + " " + byApi[key]; }).join(" · ")
      : "—";

  }

  // ---------------------------------------------------------------- 钉钉详情抽屉

  function fmtWhen(ts) {
    if (!ts) return "—";
    var date = new Date(Number(ts));
    if (!Number.isFinite(date.getTime())) return "—";
    return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function dingtalkAmountSummary(map) {
    var source = map || {};
    var keys = Object.keys(source);
    if (!keys.length) return "—";
    return keys.sort(function (a, b) { return source[b] - source[a]; })
      .map(function (key) { return key + " " + fmtNum(source[key]); })
      .join(" · ");
  }

  function dingtalkThresholds(thresholds) {
    var t = thresholds || {};
    var parts = [];
    if (Number.isFinite(Number(t.warnAt))) parts.push("告警 " + Math.round(Number(t.warnAt) * 100) + "%");
    if (Number.isFinite(Number(t.confirmOnlyAt))) parts.push("仅确认 " + Math.round(Number(t.confirmOnlyAt) * 100) + "%");
    if (Number.isFinite(Number(t.hardStopAt))) parts.push("停止出站 " + Math.round(Number(t.hardStopAt) * 100) + "%");
    return parts.length ? "阈值：" + parts.join(" · ") : "";
  }

  function openDtDetail() {
    if (!dom.dtDrawer) return;
    if (dom.drawer && !dom.drawer.classList.contains("hidden")) closeDetail();
    dom.dtDrawer.classList.remove("hidden");
    dom.dtScrim.classList.remove("hidden");
    renderDtDrawer();
  }

  function closeDtDetail() {
    if (!dom.dtDrawer) return;
    dom.dtDrawer.classList.add("hidden");
    dom.dtScrim.classList.add("hidden");
  }

  /** 通道、绑定、计费、调用明细都放抽屉里，右侧卡片只留摘要。 */
  function renderDtDrawer() {
    if (!dom.dtDrawerBody) return;
    var data = state.dingtalk;
    if (!data) {
      dom.dtDrawerBody.innerHTML = '<div class="emptyState">'
        + '<div class="emptyIcon">◌</div>'
        + '<div class="emptyTitle">钉钉通道未配置</div>'
        + '<div class="emptySub">在桌面端完成通道配置后，这里会显示连接、绑定和调用明细。</div>'
        + '</div>';
      return;
    }
    var info = dingtalkState(data);
    var binding = data.binding || {};
    var usage = data.usage || {};
    var local = usage.local || {};
    var bill = usage.billable || {};
    var percent = Number(bill.percent) || 0;
    var ratio = Math.min(100, Math.round(percent * 100));
    var parts = [];

    var tags = ['<span class="connTag ' + esc(info.cls) + '">' + esc(info.text) + '</span>'];
    tags.push('<span class="tag">' + esc(usage.month || "本月") + '</span>');
    tags.push('<span class="tag">' + (data.enabled ? "已启用" : "已停用") + '</span>');
    if (data.status) tags.push('<span class="tag">Stream ' + esc(data.status) + '</span>');
    parts.push('<div class="drawerStatus">' + tags.join("") + '</div>');

    parts.push('<div class="detailGrid">'
      + detailCell("绑定用户", binding.userId || "未绑定")
      + detailCell("绑定模式", binding.mode || "—")
      + detailCell("绑定时间", binding.boundAt ? fmtWhen(binding.boundAt) : "—", binding.boundAt ? new Date(binding.boundAt).toLocaleString() : "")
      + detailCell("最近入站", data.lastInboundAt ? ago(data.lastInboundAt) : "—", data.lastInboundAt ? new Date(data.lastInboundAt).toLocaleString() : "")
      + detailCell("最近出站", data.lastOutboundAt ? ago(data.lastOutboundAt) : "—", data.lastOutboundAt ? new Date(data.lastOutboundAt).toLocaleString() : "")
      + detailCell("最近本地调用", local.lastAt ? ago(local.lastAt) : "—", local.lastAt ? new Date(local.lastAt).toLocaleString() : "")
      + '</div>');

    if (binding.state === "waiting") {
      parts.push('<div class="dtHint">待绑定：' + (binding.code ? "绑定码 " + esc(binding.code) : "等待首条消息")
        + (binding.expiresAt ? "，" + esc(fmtWhen(binding.expiresAt)) + " 前有效" : "") + '</div>');
    } else if (binding.state === "pending_confirm") {
      parts.push('<div class="dtHint">待确认绑定：' + esc(binding.pendingNick || "未知用户") + '</div>');
    }
    if (data.lastError) parts.push('<div class="dtAlert">最近错误：' + esc(data.lastError) + '</div>');
    if (usage.quotaExhausted) parts.push('<div class="dtAlert">额度已用尽（' + esc(usage.quotaReason || "quota") + "），出站已停止。</div>");

    var directions = bill.byDirection || {};
    var thresholds = dingtalkThresholds(usage.thresholds);
    parts.push('<div class="detailSection"><div class="detailLabel"><span>本月计费额度</span><span>' + ratio + '%</span></div>'
      + '<div class="usageBar"><i class="' + (percent >= 1 ? "bad" : percent >= 0.8 ? "warn" : "") + '" style="width:' + ratio + '%"></i></div>'
      + '<div class="detailGrid dtGrid">'
      + detailCell("计费调用", fmtNum(bill.total || 0))
      + detailCell("额度上限", fmtNum(bill.limit || 0))
      + detailCell("使用比例", ratio + "%")
      + detailCell("今日", fmtNum(bill.today || 0))
      + detailCell("入站 / 出站", (directions.in || 0) + " / " + (directions.out || 0))
      + detailCell("失败", fmtNum(bill.failures || 0))
      + '</div>'
      + (bill.byKind && Object.keys(bill.byKind).length ? '<div class="dtHint">按类型：' + esc(dingtalkAmountSummary(bill.byKind)) + '</div>' : "")
      + (thresholds ? '<div class="dtHint">' + esc(thresholds) + '</div>' : "")
      + '</div>');

    parts.push('<div class="detailSection"><div class="detailLabel"><span>本月本地调用</span><span>共 ' + fmtNum(local.total || 0) + ' 次</span></div>'
      + '<div class="detailGrid dtGrid">'
      + detailCell("今日", fmtNum(local.today || 0))
      + detailCell("成功", fmtNum(local.ok || 0))
      + detailCell("失败 / 重试", (local.fail || 0) + " / " + (local.retries || 0))
      + '</div>'
      + '<div class="dtHint">按类别：' + esc(dingtalkAmountSummary(local.byCategory))
      + ' · 按来源：' + esc(dingtalkAmountSummary(local.bySource)) + '</div></div>');

    var byApi = local.byApi || {};
    var apiKeys = Object.keys(byApi)
      .sort(function (a, b) { return byApi[b] - byApi[a]; })
      .slice(0, 10);
    if (apiKeys.length) {
      var maxCount = byApi[apiKeys[0]] || 1;
      parts.push('<div class="detailSection"><div class="detailLabel"><span>按接口</span><span>Top ' + apiKeys.length + '</span></div>'
        + '<div class="dtApiList">' + apiKeys.map(function (key) {
          return '<div class="dtApiRow"><span class="dtApiName" title="' + esc(key) + '">' + esc(key) + '</span>'
            + '<span class="dtApiBar"><i style="width:' + Math.max(4, Math.round((byApi[key] / maxCount) * 100)) + '%"></i></span>'
            + '<b>' + fmtNum(byApi[key]) + '</b></div>';
        }).join("") + '</div></div>');
    }

    var recent = (local.recent || []).slice(0, 20);
    parts.push('<div class="detailSection"><div class="detailLabel"><span>最近调用</span><span>最近 ' + recent.length + ' 条</span></div>'
      + (recent.length
        ? '<div class="recentCalls">' + recent.map(function (item) {
          return '<div class="recentCall dt">'
            + '<span class="' + (item.ok ? "ok" : "bad") + '">' + (item.ok ? "✓" : "✕") + '</span>'
            + '<span class="api" title="' + esc(item.api) + '">' + esc(clip(item.api, 48)) + '</span>'
            + '<span class="cat">' + esc(item.category || "") + '</span>'
            + '<span class="ms">' + (item.ms || 0) + 'ms</span>'
            + '<span class="time">' + esc(fmtWhen(item.at)) + '</span>'
            + '</div>';
        }).join("") + '</div>'
        : '<div class="emptyMini">暂无调用</div>')
      + '</div>');

    parts.push('<div class="footNote">本地调用逐条计；计费以钉钉资源管理为准。</div>');
    var scrollTop = dom.dtDrawerBody.scrollTop;
    dom.dtDrawerBody.innerHTML = parts.join("");
    dom.dtDrawerBody.scrollTop = scrollTop;
  }

  function renderAll() {
    renderStats();
    renderSources();
    renderSessions();
    renderPending();
    renderDingtalk();
    if (dom.dtDrawer && !dom.dtDrawer.classList.contains("hidden")) renderDtDrawer();
    renderEvents();
    renderFooter();
    if (state.selected) renderDrawer();
  }

  function refreshTimes() {
    var now = Date.now();
    if (dom.clock) dom.clock.textContent = clockText(now);
    if (dom.uptime && state.startedAt) {
      dom.uptime.textContent = "服务 " + fmtDuration(now - state.startedAt);
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-ago]"), function (el) {
      var value = el.getAttribute("data-ago");
      if (!value) return;
      el.textContent = ago(Number(value));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-runfor]"), function (el) {
      var id = el.getAttribute("data-runfor");
      if (!id) return;
      var span = runDuration(id);
      el.textContent = span ? "已运行 " + fmtDuration(span) : "运行中";
    });
  }

  // ---------------------------------------------------------------- 详情

  function openDetail(id) {
    if (!id || !state.sessions.has(id)) return;
    if (dom.dtDrawer && !dom.dtDrawer.classList.contains("hidden")) closeDtDetail();
    state.selected = id;
    dom.drawer.classList.remove("hidden");
    dom.scrim.classList.remove("hidden");
    renderSessions();
    renderDrawer();
  }

  function closeDetail() {
    state.selected = "";
    dom.drawer.classList.add("hidden");
    dom.scrim.classList.add("hidden");
    renderSessions();
  }

  function detailCell(label, value, title) {
    return '<div class="detailCell"><span>' + esc(label) + '</span><b title="' + esc(title || value) + '">' + esc(value) + '</b></div>';
  }

  function renderDrawer() {
    var session = state.sessions.get(state.selected);
    if (!session) {
      dom.drawerTitle.textContent = "会话已离线";
      dom.drawerBody.innerHTML = '<div class="emptyMini">这个会话已经不在当前快照里。</div>';
      return;
    }
    var info = statusInfo(session);
    var cls = statusClass(session);
    var tokens = tokenTotal(session);
    dom.drawerTitle.textContent = session.title || session.sessionId;
    var pending = pendingLabel(session);
    var parts = [];
    parts.push('<div class="drawerStatus">'
      + '<span class="pill ' + esc(cls) + '">' + esc(info.label) + '</span>'
      + '<span class="agentTag ' + esc(agentClass(session)) + '">' + esc(agentName(session)) + '</span>'
      + (session.parentId ? '<span class="tag branch">分支会话</span>' : "")
      + (pending ? '<span class="pendingFlag">' + esc(pending) + '</span>' : "")
      + '</div>');
    parts.push('<div class="drawerPath">' + esc(session.cwd || "无工作目录") + '</div>');
    parts.push('<div class="detailGrid">'
      + detailCell("轮次", String(session.turns || 0))
      + detailCell("步骤", String(session.steps || 0))
      + detailCell("Token", tokens == null ? "—" : fmtNum(tokens))
      + detailCell("最近更新", ago(session.updatedAt), new Date(session.updatedAt || Date.now()).toLocaleString())
      + detailCell("运行时长", cls === "running" ? fmtDuration(runDuration(session.sessionId)) : "—")
      + detailCell("等待项", String((session.pending && session.pending.length) || 0))
      + '</div>');
    if (session.lastPrompt) {
      parts.push('<div class="detailSection"><div class="detailLabel"><span>最近一轮 · 你</span></div>'
        + '<div class="detailText">' + esc(session.lastPrompt) + '</div></div>');
    }
    if (session.lastResponse) {
      parts.push('<div class="detailSection"><div class="detailLabel"><span>最近一轮 · Agent</span></div>'
        + '<div class="detailText">' + esc(session.lastResponse) + '</div></div>');
    }
    if (session.lastRun) {
      parts.push('<div class="detailSection"><div class="detailLabel"><span>上一轮结果</span><span>' + esc(ago(session.lastRun.finishedAt)) + '</span></div>'
        + '<div class="detailText">' + esc((session.lastRun.outcome || "") + (session.lastRun.text ? "\n" + session.lastRun.text : "")) + '</div></div>');
    }
    var todos = session.todos;
    if (Array.isArray(todos) && todos.length) {
      parts.push('<div class="detailSection"><div class="detailLabel"><span>任务清单</span></div><div class="todoList">'
        + todos.map(function (todo) {
          var text = typeof todo === "string" ? todo : (todo.content || todo.text || todo.title || todo.subject || JSON.stringify(todo));
          var status = typeof todo === "object" && todo ? (todo.status || todo.state || "") : "";
          return '<div class="todoItem"><span class="todoDot ' + esc(status) + '"></span><span>' + esc(text) + '</span></div>';
        }).join("")
        + '</div></div>');
    } else if (todos) {
      parts.push('<div class="detailSection"><div class="detailLabel"><span>任务清单</span></div><pre class="detailPre">' + esc(JSON.stringify(todos, null, 2)) + '</pre></div>');
    }
    if (session.plan) {
      parts.push('<div class="detailSection"><div class="detailLabel"><span>计划</span></div><pre class="detailPre">'
        + esc(typeof session.plan === "string" ? session.plan : JSON.stringify(session.plan, null, 2)) + '</pre></div>');
    }
    if (session.subagent) {
      parts.push('<div class="detailSection"><div class="detailLabel"><span>子代理</span></div><pre class="detailPre">'
        + esc(typeof session.subagent === "string" ? session.subagent : JSON.stringify(session.subagent, null, 2)) + '</pre></div>');
    }
    if (session.tokenUsage && typeof session.tokenUsage === "object") {
      parts.push('<div class="detailSection"><div class="detailLabel"><span>Token 明细</span></div><pre class="detailPre">'
        + esc(JSON.stringify(session.tokenUsage, null, 2)) + '</pre></div>');
    }
    var raw = {
      sessionId: session.sessionId,
      runId: session.runId || null,
      agent: session.agent,
      status: session.status,
      running: !!session.running,
      updatedAt: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : null,
      capabilities: session.capabilities || null,
      pending: session.pending || [],
    };
    parts.push('<div class="detailSection"><div class="detailLabel"><span>运行信息</span></div><pre class="detailPre">'
      + esc(JSON.stringify(raw, null, 2)) + '</pre></div>');
    dom.drawerBody.innerHTML = parts.join("");
  }

  // ---------------------------------------------------------------- 连接

  function showBanner(text, bad) {
    dom.banner.textContent = text;
    dom.banner.className = "banner" + (bad ? " bad" : "");
  }

  function hideBanner() {
    dom.banner.className = "banner hidden";
    dom.banner.textContent = "";
  }

  function fatalAuth() {
    setConn("未授权", "off");
    showBanner("本机鉴权失效：请从菜单栏「打开监控屏」重新进入。", true);
  }

  function loadSnapshot(options) {
    var light = !!(options && options.light);
    return fetch("/monitor/state?ts=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) {
          fatalAuth();
          throw new Error("unauthorized");
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || "bad snapshot");
        if (light) applyLightSnapshot(data);
        else applySnapshot(data);
        state.loadFailures = 0;
        hideBanner();
        return data;
      });
  }

  /** SSE 只推会话/事件，钉钉连接状态、进程数这类快照字段要定时拉取。 */
  function snapshotPollMs() {
    var ms = Number(state.monitor && state.monitor.pollMs);
    if (!Number.isFinite(ms) || ms < 500) ms = 3000;
    return Math.min(5000, Math.max(2000, ms));
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(function () {
      // SSE 在线时只补快照类字段；断线时退回整份快照，保证会话也不掉队。
      loadSnapshot({ light: state.connected }).then(function () {
        if (!state.connected) setConn("轮询中", "connecting");
      }).catch(function () { /* 继续等下一轮 */ });
    }, snapshotPollMs());
  }

  function connect() {
    if (state.stream) {
      try { state.stream.close(); } catch (error) { /* 忽略 */ }
    }
    var stream = new EventSource("/monitor/events?since=" + encodeURIComponent(state.seq || 0));
    state.stream = stream;
    stream.onopen = function () {
      state.connected = true;
      setConn("已连接", "on");
      hideBanner();
    };
    stream.onmessage = function (message) {
      var event;
      try { event = JSON.parse(message.data); } catch (error) { return; }
      handleEvent(event);
    };
    stream.onerror = function () {
      if (state.stream !== stream) return;
      state.connected = false;
      setConn("重连中…", "off");
      startPolling();
    };
  }

  function boot() {
    loadSnapshot().then(function () {
      connect();
      startPolling();
    }).catch(function (error) {
      if (String(error && error.message) === "unauthorized") return;
      state.loadFailures += 1;
      setConn("无法连接", "off");
      showBanner("连不上本地服务，正在重试…（" + (error && error.message ? error.message : "unknown") + "）", true);
      if (!state.snapshotTimer) {
        state.snapshotTimer = setInterval(function () {
          loadSnapshot().then(function () {
            clearInterval(state.snapshotTimer);
            state.snapshotTimer = null;
            connect();
          }).catch(function () { /* 继续重试 */ });
        }, 2500);
      }
    });
  }

  // ---------------------------------------------------------------- 绑定

  dom.stats.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest(".stat") : null;
    if (!button) return;
    var filter = button.getAttribute("data-filter") || "all";
    state.filter = state.filter === filter ? "all" : filter;
    renderStats();
    renderSessions();
  });

  dom.filters.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest(".filter") : null;
    if (!button) return;
    state.filter = button.getAttribute("data-filter") || "all";
    renderStats();
    renderSessions();
  });

  dom.search.addEventListener("input", function () {
    state.search = dom.search.value.trim();
    renderSessions();
  });

  dom.sessionList.addEventListener("click", function (event) {
    var card = event.target.closest ? event.target.closest(".session") : null;
    if (!card) return;
    openDetail(card.getAttribute("data-id"));
  });

  dom.pendingList.addEventListener("click", function (event) {
    var item = event.target.closest ? event.target.closest(".pendingItem") : null;
    if (!item) return;
    var id = item.getAttribute("data-session");
    if (id) openDetail(id);
  });

  dom.btnSettings.addEventListener("click", function () {
    if (typeof window.__electrobunSendToHost === "function") {
      try {
        window.__electrobunSendToHost({ type: "open-settings", tab: "app" });
        return;
      } catch (error) { /* 退化为同页跳转 */ }
    }
    location.assign("/settings?tab=app");
  });

  dom.btnPause.addEventListener("click", function () {
    state.paused = !state.paused;
    dom.btnPause.textContent = state.paused ? "继续" : "暂停";
    dom.btnPause.title = state.paused ? "继续界面刷新" : "暂停界面刷新，不影响 Agent 运行";
    dom.btnPause.setAttribute("aria-pressed", state.paused ? "true" : "false");
    dom.btnPause.classList.toggle("on", state.paused);
    if (!state.paused) renderAll();
  });

  dom.btnDrawerClose.addEventListener("click", closeDetail);
  dom.scrim.addEventListener("click", closeDetail);
  dom.dtDetailBtn.addEventListener("click", openDtDetail);
  dom.btnDtDrawerClose.addEventListener("click", closeDtDetail);
  dom.dtScrim.addEventListener("click", closeDtDetail);

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (dom.dtDrawer && !dom.dtDrawer.classList.contains("hidden")) {
      closeDtDetail();
      return;
    }
    if (!dom.drawer.classList.contains("hidden")) {
      closeDetail();
      return;
    }
    if (window.__electrobunSendToHost) {
      try { window.__electrobunSendToHost({ type: "panel-close" }); return; } catch (error) { /* 忽略 */ }
    }
    try { window.close(); } catch (error) { /* 忽略 */ }
  });

  window.addEventListener("online", function () {
    if (!state.connected) {
      loadSnapshot().then(function () { connect(); }).catch(function () { /* 忽略 */ });
    }
  });

  setInterval(refreshTimes, 1000);
  refreshTimes();
  boot();
})();
