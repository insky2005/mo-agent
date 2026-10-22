(function () {
  "use strict";

  var LS = {
    token: "mo-agent.token",
    seq: "mo-agent.seq",
    selected: "mo-agent.selected",
    speak: "mo-agent.speak"
  };

  // 配对壳跳到「实时界面」时会带 live/t/shell。
  // 实时界面的页面来自电脑本身，所以走相对地址，token 存在当前 origin 自己的 storage。
  var liveParams = null;
  try { liveParams = new URLSearchParams(location.search); } catch (error) { liveParams = null; }
  var LIVE = !!(liveParams && liveParams.get("live") === "1");
  var STAY = !!(liveParams && liveParams.get("stay") === "1");
  var SHELL_ORIGIN = "";
  // 首次配对后先留在本机界面；用户手动点过「进入实时界面」才记住，之后启动直接进。
  var AUTO_LIVE = localStorage.getItem("mo-agent.live") === "1";
  if (LIVE) {
    localStorage.removeItem("mo-agent.base");
    var liveToken = liveParams.get("t");
    if (liveToken) localStorage.setItem(LS.token, liveToken);
    var liveShell = liveParams.get("shell");
    if (liveShell) { try { sessionStorage.setItem("mo-agent.shell", liveShell); } catch (error) { /* 忽略 */ } }
  }
  try { SHELL_ORIGIN = sessionStorage.getItem("mo-agent.shell") || ""; } catch (error) { SHELL_ORIGIN = ""; }

  // 本机壳层资源随 APK 更新，不需要 Service Worker；早期版本注册过的 SW
  // 会缓存旧 app.js，必须注销并清掉缓存，否则界面会一直停在旧版。
  function cleanupServiceWorker() {
    try {
      if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return;
      navigator.serviceWorker.getRegistrations().then(function (list) {
        if (!list.length) return;
        Promise.all(list.map(function (reg) {
          return reg.unregister().catch(function () { /* 忽略 */ });
        })).then(function () {
          if (!window.caches || !caches.keys) return;
          caches.keys().then(function (keys) {
            keys.forEach(function (key) { caches.delete(key).catch(function () { /* 忽略 */ }); });
          }).catch(function () { /* 忽略 */ });
        });
      }).catch(function () { /* 忽略 */ });
    } catch (error) { /* 忽略 */ }
  }

  var BASE = localStorage.getItem("mo-agent.base") || "";
  // Capacitor 外壳里页面来自 https://localhost；浏览器打开时页面就是电脑本身
  var NATIVE = location.protocol === "capacitor:" || location.hostname === "localhost";
  var connFailed = false;
  var localBuild = null;
  var remoteBuild = null;

  var STATUS = {
    submitted: { label: "已提交", cls: "running" },
    working: { label: "运行中", cls: "running" },
    "input-required": { label: "等待回答", cls: "waiting" },
    "auth-required": { label: "等待授权", cls: "waiting" },
    completed: { label: "已完成", cls: "idle" },
    canceled: { label: "已中断", cls: "idle" },
    failed: { label: "失败", cls: "error" },
    rejected: { label: "已拒绝", cls: "error" },
    idle: { label: "空闲", cls: "idle" }
  };

  var AGENT_LABELS = { dsh: "DeepSeek Harness", "claude-code": "Claude Code", "qoder-cn": "Qoder CN", workbuddy: "WorkBuddy" };

  function agentName(session) {
    if (!session) return "Agent";
    return session.agentLabel || AGENT_LABELS[session.agent] || session.agent || "Agent";
  }

  function agentClass(session) {
    if (!session) return "other";
    if (session.agent === "claude-code") return "claude";
    if (session.agent === "dsh") return "dsh";
    if (session.agent === "qoder-cn") return "qoder";
    if (session.agent === "workbuddy") return "workbuddy";
    return "other";
  }

  /**
   * 会话卡片上的路径：家目录缩成 ~，太长时省略中间，但最后一级目录必须保留。
   * 例：/Users/dev/c/work.ai/git/authx-platform -> ~/c/…/authx-platform
   */
  function displayPath(value) {
    var text = String(value || "");
    if (!text) return "";
    text = text
      .replace(/^\/Users\/[^/]+\//, "~/")
      .replace(/^\/home\/[^/]+\//, "~/")
      .replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, "~\\");
    var limit = 34;
    if (text.length <= limit) return text;
    var sep = text.indexOf("\\") !== -1 && text.indexOf("/") === -1 ? "\\" : "/";
    var prefix = text.indexOf("~/") === 0 ? "~/" : (text.indexOf("~\\") === 0 ? "~\\" : (text.indexOf("/") === 0 ? "/" : ""));
    var parts = text.slice(prefix.length).split(/[\\/]/).filter(Boolean);
    if (!parts.length) return text;
    var last = parts[parts.length - 1];
    // 从左边尽量多保留几级目录，只在不够放时省略中间；最后一级永远保留。
    for (var keep = parts.length - 1; keep >= 1; keep -= 1) {
      var candidate = prefix + parts.slice(0, keep).join(sep) + sep + "…" + sep + last;
      if (candidate.length <= limit) return candidate;
    }
    var minimal = prefix + "…" + sep + last;
    return minimal.length <= limit ? minimal : "…" + sep + last;
  }

  function pendingMeta(p) {
    return [p && p.agentLabel, p && p.sessionTitle].filter(Boolean).join(" · ");
  }

  function canControl(session, action) {
    if (!session) return false;
    var caps = session.capabilities;
    if (caps && Array.isArray(caps.control)) return caps.control.indexOf(action) >= 0;
    // 兼容没有 capabilities 的旧快照：Claude Code 仍然是只读。
    return session.agent !== "claude-code";
  }

  var state = {
    token: localStorage.getItem(LS.token) || "",
    seq: Number(localStorage.getItem(LS.seq) || 0) || 0,
    selected: localStorage.getItem(LS.selected) || "",
    speak: localStorage.getItem(LS.speak) === "1",
    onlyActive: true,
    detailId: "",
    detailTurns: null,
    detailIndex: -1,
    detailTotal: 0,
    detailLoading: false,
    detailTruncated: false,
    detailAnim: "",
    detailResetScroll: false,
    detailError: "",
    sessions: new Map(),
    pending: new Map(),
    es: null,
    online: false,
    notified: new Set()
  };

  var dom = {};
  var IDS = ["conn", "btnNotify", "btnSpeak", "btnRefresh", "pendingSection", "pendingList", "sessionList", "onlyActive", "target", "input", "btnMic", "btnSend", "pairOverlay", "pinInput", "btnPair", "pairError", "main", "linkBar", "linkText", "btnRepair", "addrInput", "pairHint", "btnGoLive", "detailOverlay", "detailTitle", "detailMeta", "detailHistory", "detailNav", "detailTurnLabel", "btnPrevTurn", "btnNextTurn", "btnDetailClose"];
  IDS.forEach(function (id) { dom[id] = document.getElementById(id); });

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ago(ts) {
    if (!ts) return "";
    var delta = Date.now() - ts;
    if (delta < 60000) return Math.max(1, Math.round(delta / 1000)) + " 秒前";
    if (delta < 3600000) return Math.round(delta / 60000) + " 分钟前";
    if (delta < 86400000) return Math.round(delta / 3600000) + " 小时前";
    return Math.round(delta / 86400000) + " 天前";
  }

  function setConn(on, text) {
    state.online = !!on;
    dom.conn.className = "conn " + (on ? "on" : "off");
    dom.conn.textContent = text || (on ? "已连接" : "未连接");
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { "x-mo-agent-token": state.token };
    if (opts.headers) Object.assign(headers, opts.headers);
    if (opts.body) headers["content-type"] = "application/json";
    return fetch(BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        showPair();
        throw new Error("未配对");
      }
      return res.json();
    });
  }

  function showPair() {
    dom.pairOverlay.classList.remove("hidden");
    setTimeout(function () { dom.pinInput.focus(); }, 120);
  }

  // ---------------------------------------------------------------- 渲染

  function loadLocalBuild() {
    fetch("build-info.json").then(function (res) { return res.ok ? res.json() : null; }).then(function (info) {
      localBuild = info || null;
      renderLink();
    }).catch(function () { /* 源码直跑时可能没有 */ });
  }

  function loadRemoteBuild() {
    api("/app/version").then(function (result) {
      if (result && result.ok) { remoteBuild = result; renderLink(); }
    }).catch(function () { /* 忽略 */ });
  }

  function renderLink() {
    if (!dom.linkBar) return;
    if (LIVE) {
      dom.linkBar.classList.remove("hidden");
      dom.linkText.textContent = "实时界面 · 来自电脑（刷新即最新）";
      if (dom.btnRepair) dom.btnRepair.textContent = SHELL_ORIGIN ? "⌂ 回本机界面" : "刷新";
      if (dom.btnGoLive) dom.btnGoLive.classList.add("hidden");
      return;
    }
    if (dom.btnRepair) dom.btnRepair.textContent = "重新配对";
    if (dom.btnGoLive) { if (NATIVE && BASE) dom.btnGoLive.classList.remove("hidden"); else dom.btnGoLive.classList.add("hidden"); }
    if (!BASE) {
      dom.linkBar.classList.add("hidden");
      return;
    }
    dom.linkBar.classList.remove("hidden");
    var host = BASE.replace(/^https?:\/\//, "");
    var extra = "";
    if (localBuild && localBuild.versionCode) extra += " · 本机 v" + localBuild.versionCode;
    if (remoteBuild && remoteBuild.versionCode) extra += " / 电脑 v" + remoteBuild.versionCode;
    if (localBuild && remoteBuild && remoteBuild.versionCode > localBuild.versionCode) extra += " ↑有新版本";
    dom.linkText.textContent = (connFailed ? ("连不上 " + host + "（可能换了网络，需要重新配对）") : ("已连接到 " + host)) + extra;
  }

  function render() {
    renderLink();
    renderSessions();
    renderPending();
    renderTarget();
    if (state.detailId) renderDetail();
  }

  function activeSessionList() {
    var list = [];
    state.sessions.forEach(function (s) { list.push(s); });
    list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if (state.onlyActive) {
      list = list.filter(function (s) {
        if (s.running || (s.pending && s.pending.length)) return true;
        if (state.selected === s.sessionId) return true;
        // 派生分支（DSH fork）不属于「活跃」：父会话没在跑时，分支只是历史
        if (s.parentId) return false;
        return Date.now() - (s.updatedAt || 0) < 6 * 3600 * 1000;
      });
    }
    return list.slice(0, 30);
  }

  function renderSessions() {
    var list = activeSessionList();
    if (!list.length) {
      dom.sessionList.innerHTML = '<div class="empty">暂无活跃会话</div>';
      return;
    }
    var titleCounts = {};
    list.forEach(function (s) {
      var key = s.title || s.sessionId;
      titleCounts[key] = (titleCounts[key] || 0) + 1;
    });
    var html = list.map(function (s) {
      var info = STATUS[s.status] || STATUS.idle;
      var displayTitle = s.title || s.sessionId;
      if (titleCounts[displayTitle] > 1) displayTitle += " · " + String(s.sessionId).slice(-6);
      var selected = state.selected === s.sessionId;
      var attention = s.status === "waiting" || s.status === "error";
      var parts = [];
      parts.push('<div class="card' + (selected ? " selected" : "") + (attention ? " attention" : "") + '" data-id="' + esc(s.sessionId) + '">');
      parts.push('<div class="cardTop"><div class="cardTitle">' + esc(displayTitle) + (s.parentId ? ' <span class="tag">分支</span>' : '') + '</div>');
      // Agent 标签放在状态徽章前面，不抢标题的位置。
      parts.push('<span class="tag agent ' + agentClass(s) + '">' + esc(agentName(s)) + '</span>');
      parts.push('<span class="badge ' + info.cls + '">' + info.label + '</span></div>');
      var origin = s.parentId ? '分支自其它会话 · ' : '';
      // 路径可截断；时间与轮数固定在右侧，始终可见。
      parts.push('<div class="meta sessionMeta">'
        + '<span class="metaPath" title="' + esc(s.cwd || "") + '">' + origin + esc(displayPath(s.cwd)) + '</span>'
        + '<span class="metaRight">' + ago(s.updatedAt) + ' · 第 ' + (s.turns || 0) + ' 轮</span>'
        + '</div>');
      if (s.lastPrompt) parts.push('<div class="line clamp" data-detail="' + esc(s.sessionId) + '"><b>你：</b>' + esc(s.lastPrompt) + '</div>');
      if (s.lastResponse) parts.push('<div class="line clamp" data-detail="' + esc(s.sessionId) + '"><b>Agent：</b>' + esc(s.lastResponse) + '</div>');
      parts.push('<div class="cardActions">');
      // 「选中」已去掉：点卡片任意位置即选中，卡片高亮就是反馈
      parts.push('<button data-act="detail" data-id="' + esc(s.sessionId) + '">查看完整</button>');
      if (canControl(s, "prompt")) {
        parts.push('<button data-act="continue" data-id="' + esc(s.sessionId) + '">发『继续』</button>');
      } else {
        parts.push('<span class="readonly">仅观测，不能发送指令</span>');
      }
      if (s.running && canControl(s, "cancel")) {
        parts.push('<button class="no" data-act="stop" data-id="' + esc(s.sessionId) + '">中断</button>');
      }
      parts.push('</div></div>');
      return parts.join("");
    }).join("");
    dom.sessionList.innerHTML = html;
  }

  function renderPending() {
    var list = [];
    state.pending.forEach(function (p) { list.push(p); });
    if (!list.length) {
      dom.pendingSection.classList.add("hidden");
      dom.pendingList.innerHTML = "";
      return;
    }
    dom.pendingSection.classList.remove("hidden");
    dom.pendingList.innerHTML = list.map(function (p) {
      if (p.kind === "approval") return renderApproval(p);
      return renderQuestion(p);
    }).join("");
  }

  function renderApproval(p) {
    var q = p.question || {};
    var parts = [];
    parts.push('<div class="card attention" data-event="' + esc(p.eventId) + '">');
    parts.push('<div class="cardTop"><div class="cardTitle">等待授权</div><span class="badge waiting">等待确认</span></div>');
    var approvalMeta = pendingMeta(p);
    if (approvalMeta) parts.push('<div class="meta">' + esc(approvalMeta) + '</div>');
    parts.push('<div class="qText">' + esc(q.reason || q.toolName || "Agent 需要你的授权才能继续") + '</div>');
    parts.push('<div class="cardActions">');
    parts.push('<button class="ok" data-act="approve" data-event="' + esc(p.eventId) + '" data-value="allowed-once">允许一次</button>');
    parts.push('<button class="no" data-act="approve" data-event="' + esc(p.eventId) + '" data-value="rejected">拒绝</button>');
    parts.push('</div></div>');
    return parts.join("");
  }

  function renderQuestion(p) {
    var q = p.question || {};
    var questions = q.questions || [];
    var parts = [];
    parts.push('<div class="card attention" data-event="' + esc(p.eventId) + '">');
    parts.push('<div class="cardTop"><div class="cardTitle">Agent 正在询问</div><span class="badge waiting">等待回应</span></div>');
    var questionMeta = pendingMeta(p);
    if (questionMeta) parts.push('<div class="meta">' + esc(questionMeta) + '</div>');
    if (!questions.length) {
      parts.push('<div class="qText">Agent 需要你的输入</div>');
      parts.push('<input class="customInput" data-custom-for="__single" placeholder="输入你的回答" />');
    }
    questions.forEach(function (item, index) {
      parts.push('<div class="q" data-qid="' + esc(item.id || ("q" + index)) + '">');
      if (item.header) parts.push('<div class="qHeader">' + esc(item.header) + '</div>');
      parts.push('<div class="qText">' + esc(item.question || "") + '</div>');
      if (item.detail) parts.push('<div class="meta">' + esc(item.detail) + '</div>');
      var options = item.options || [];
      if (options.length) {
        parts.push('<div class="options">');
        options.forEach(function (opt) {
          var type = item.multiSelect ? "checkbox" : "radio";
          var name = "q_" + esc(p.eventId) + "_" + index;
          parts.push('<label class="option"><input type="' + type + '" name="' + name + '" value="' + esc(opt.label) + '" />');
          parts.push('<span>' + esc(opt.label) + (opt.description ? ' · <span class="meta">' + esc(opt.description) + '</span>' : "") + '</span></label>');
        });
        parts.push('</div>');
      }
      parts.push('<input class="customInput" placeholder="或输入自定义回答" />');
      parts.push('</div>');
    });
    parts.push('<div class="cardActions">');
    parts.push('<button class="send" data-act="answer" data-event="' + esc(p.eventId) + '">提交回答</button>');
    parts.push('<button class="no" data-act="cancelPending" data-event="' + esc(p.eventId) + '">忽略</button>');
    parts.push('</div></div>');
    return parts.join("");
  }

  function renderTarget() {
    var s = state.sessions.get(state.selected);
    if (!s) {
      dom.target.innerHTML = "发送给：<b>未选择会话</b>";
      dom.input.disabled = false;
      dom.btnSend.disabled = false;
      dom.btnMic.disabled = false;
      dom.input.placeholder = "输入指令，或说出你的指令…";
      return;
    }
    var can = canControl(s, "prompt");
    dom.target.innerHTML = (can ? "发送给：" : "仅观测：")
      + "<b>" + esc(agentName(s)) + " · " + esc(s.title || s.sessionId) + "</b>"
      + (can ? "" : "（该 Agent 不能接收手机指令）");
    dom.input.disabled = !can;
    dom.btnSend.disabled = !can;
    dom.btnMic.disabled = !can;
    dom.input.placeholder = can ? "输入指令，或说出你的指令…" : "该会话仅观测，不能发送指令";
  }

  function openDetail(id) {
    if (!id) return;
    state.detailId = id;
    state.detailTurns = null;
    state.detailIndex = -1;
    state.detailTotal = 0;
    state.detailLoading = true;
    state.detailTruncated = false;
    state.detailAnim = "";
    state.detailResetScroll = false;
    state.detailError = "";
    renderDetail();
    dom.detailOverlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    loadHistory(id);
  }

  function closeDetail() {
    state.detailId = "";
    state.detailTurns = null;
    state.detailIndex = -1;
    state.detailTotal = 0;
    state.detailLoading = false;
    state.detailTruncated = false;
    state.detailAnim = "";
    state.detailResetScroll = false;
    state.detailError = "";
    dom.detailOverlay.classList.add("hidden");
    dom.detailNav.classList.add("hidden");
    document.body.style.overflow = "";
  }

  function showOlder() {
    if (!state.detailTurns || state.detailIndex <= 0) return;
    state.detailIndex -= 1;
    state.detailAnim = "from-left";
    state.detailResetScroll = true;
    renderDetail();
  }

  function showNewer() {
    if (!state.detailTurns || state.detailIndex >= state.detailTurns.length - 1) return;
    state.detailIndex += 1;
    state.detailAnim = "from-right";
    state.detailResetScroll = true;
    renderDetail();
  }

  function loadHistory(id) {
    api("/api/session-history?sessionId=" + encodeURIComponent(id) + "&limit=50")
      .then(function (result) {
        if (state.detailId !== id) return;
        state.detailLoading = false;
        if (result && result.ok) {
          state.detailTurns = result.turns || [];
          state.detailTotal = result.total || state.detailTurns.length;
          state.detailIndex = state.detailTurns.length - 1;
          state.detailTruncated = !!result.truncated;
          state.detailResetScroll = true;
          state.detailError = "";
        } else {
          state.detailTurns = [];
          state.detailTotal = 0;
          state.detailError = (result && result.error) || "历史加载失败";
        }
        renderDetail();
      })
      .catch(function (error) {
        if (state.detailId !== id) return;
        state.detailLoading = false;
        state.detailTurns = [];
        state.detailTotal = 0;
        state.detailError = error.message || "历史加载失败";
        renderDetail();
      });
  }

  function renderDetail() {
    var s = state.sessions.get(state.detailId);
    if (!s) {
      dom.detailTitle.textContent = "会话已离线";
      dom.detailMeta.textContent = "";
      dom.detailNav.classList.add("hidden");
      dom.detailHistory.innerHTML = '<div class="detailText">会话已离线</div>';
      return;
    }
    var info = STATUS[s.status] || STATUS.idle;
    dom.detailTitle.textContent = agentName(s) + " · " + (s.title || s.sessionId);
    dom.detailMeta.textContent = info.label
      + " · " + (displayPath(s.cwd) || "无路径")
      + " · " + ago(s.updatedAt)
      + " · 第 " + (s.turns || 0) + " 轮";

    if (state.detailLoading) {
      dom.detailNav.classList.add("hidden");
      dom.detailHistory.innerHTML = '<div class="detailLoading">正在加载历史…</div>';
      return;
    }

    var turns = state.detailTurns;
    if (!turns || !turns.length) {
      dom.detailNav.classList.add("hidden");
      var hint = state.detailError || "没有历史记录，显示最近一轮";
      dom.detailHistory.innerHTML = '<div class="detailMore">' + esc(hint) + '</div>'
        + '<div class="detailLabel">你</div>'
        + '<div class="detailText">' + esc(s.lastPrompt || "（无）") + '</div>'
        + '<div class="detailLabel">Agent</div>'
        + '<div class="detailText">' + esc(s.lastResponse || "（无）") + '</div>';
      return;
    }

    if (state.detailIndex < 0) state.detailIndex = turns.length - 1;
    if (state.detailIndex >= turns.length) state.detailIndex = turns.length - 1;
    var turn = turns[state.detailIndex];
    var turnNo = turn.turn || (state.detailIndex + 1);
    var total = state.detailTotal || turns.length;

    dom.detailNav.classList.remove("hidden");
    dom.detailTurnLabel.textContent = "第 " + turnNo + " / " + total + " 轮";
    var newer = turns[state.detailIndex + 1] || null;
    var older = turns[state.detailIndex - 1] || null;
    // 左侧按钮 = 更新一轮，右侧按钮 = 更早一轮；直接显示相邻轮次号。
    dom.btnPrevTurn.textContent = newer ? "← " + newer.turn + " 轮" : "← 已最新";
    dom.btnNextTurn.textContent = older ? older.turn + " 轮 →" : "已最早 →";
    dom.btnPrevTurn.disabled = !newer;
    dom.btnNextTurn.disabled = !older;

    var animClass = state.detailAnim ? (" " + state.detailAnim) : "";
    state.detailAnim = "";
    var resetScroll = state.detailResetScroll;
    var previousScroll = dom.detailHistory.scrollTop;
    var html = '<div class="turn' + animClass + '">'
      + '<div class="detailLabel">你</div>'
      + '<div class="detailText">' + esc(turn.prompt || "（无）") + '</div>'
      + '<div class="detailLabel">Agent</div>'
      + '<div class="detailText">' + esc(turn.response || "（无）") + '</div>'
      + '</div>';
    if (state.detailTruncated) {
      html += '<div class="detailMore">仅显示最近 ' + turns.length + ' 轮，共 ' + total + ' 轮</div>';
    }
    dom.detailHistory.innerHTML = html;
    dom.detailHistory.scrollTop = resetScroll ? 0 : previousScroll;
    state.detailResetScroll = false;
  }

  // ---------------------------------------------------------------- 事件处理

  function applySnapshot(data) {
    state.sessions = new Map();
    (data.sessions || []).forEach(function (s) { state.sessions.set(s.sessionId, s); });
    state.pending = new Map();
    (data.questions || []).forEach(function (p) { state.pending.set(p.eventId, p); });
    if (typeof data.seq === "number") {
      state.seq = data.seq;
      localStorage.setItem(LS.seq, String(state.seq));
    }
    render();
  }

  var pollTimer = null;
  var sseErrors = 0;

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      api("/api/state").then(function (result) {
        if (result && result.ok) {
          applySnapshot(result.state);
          setConn(true, "已连接(轮询)");
          if (connFailed) { connFailed = false; renderLink(); }
      loadRemoteBuild();
        }
      }).catch(function () { setConn(false, "无法连接"); });
    }, 3000);
  }

  function connect() {
    if (state.es) { try { state.es.close(); } catch (e) { /* 忽略 */ } }
    var url = BASE + "/api/events?since=" + encodeURIComponent(state.seq)
      + "&token=" + encodeURIComponent(state.token);
    var es = new EventSource(url);
    state.es = es;
    es.onopen = function () { sseErrors = 0; stopPolling(); setConn(true); startNativeNotify(); };
    // 统一信封：所有事件走 event: message，客户端按 evt.type 分发。
    // 不再维护手写事件名清单——漏一个名字就静默丢事件。
    es.onmessage = function (event) {
      var parsed;
      try { parsed = JSON.parse(event.data); } catch (e) { return; }
      handleEvent(parsed);
    };
    es.onerror = function () {
      sseErrors += 1;
      setConn(false, "重连中…");
      // EventSource 连续失败（常见于 WebView 拦截混合内容）→ 退化为轮询，别让界面停在旧数据
      if (sseErrors >= 3) {
        try { es.close(); } catch (error) { /* 忽略 */ }
        if (state.es === es) state.es = null;
        startPolling();
      }
    };
  }

  function handleEvent(evt) {
    if (evt && typeof evt.seq === "number" && evt.seq > state.seq) {
      state.seq = evt.seq;
      localStorage.setItem(LS.seq, String(state.seq));
    }
    var p = (evt && evt.payload) || {};
    if (evt.type === "session.upsert") {
      state.sessions.set(p.sessionId, p);
      renderSessions();
    } else if (evt.type === "session.removed") {
      state.sessions.delete(p.sessionId);
      renderSessions();
    } else if (evt.type === "pending.added") {
      state.pending.set(p.eventId, p);
      renderPending();
    } else if (evt.type === "pending.resolved") {
      state.pending.delete(p.eventId);
      renderPending();
    } else if (evt.type === "notify") {
      // 通知统一由 host 的 core/notify.mjs 路由成 notify 事件，前端只负责展示
      notify(p.title || "Agent 通知", p.body || "", p.kind, evt.seq, p.severity);
    } else if (evt.type === "source.error") {
      setConn(false, "DSH 异常");
    }
  }

  function notify(title, body, kind, seq, severity) {
    if (seq && state.notified.has(seq)) return;
    if (seq) {
      state.notified.add(seq);
      if (state.notified.size > 400) state.notified = new Set();
    }
    // 只有「需要人做决定」才强提醒；完成类静默出一条通知即可
    var critical = severity === "critical";
    if (critical && navigator.vibrate) {
      try { navigator.vibrate([200, 90, 200]); } catch (e) { /* 忽略 */ }
    }
    if (critical && state.speak && window.speechSynthesis) {
      try {
        var utter = new SpeechSynthesisUtterance(title + "。" + body);
        utter.lang = "zh-CN";
        window.speechSynthesis.speak(utter);
      } catch (e) { /* 忽略 */ }
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification(title, { body: body, tag: "mo-agent-" + (kind || "notice"), icon: "/icon.svg" }); } catch (e) { /* 忽略 */ }
    }
    document.title = "● " + title;
    setTimeout(function () { document.title = "mo-agent"; }, 6000);
  }

  function nativeNotifyPlugin() {
    var C = window.Capacitor;
    return (C && C.Plugins && C.Plugins.MoAgentNotify) || null;
  }

  // 原生壳：把地址与令牌交给前台服务，之后锁屏通知由原生侧负责
  function startNativeNotify() {
    if (!NATIVE || !BASE || !state.token) return;
    var plugin = nativeNotifyPlugin();
    if (!plugin) return;
    try {
      // 现在通知走 HMS 系统推送，不再需要前台 SSE 服务与电池白名单
      plugin.start({ base: BASE, token: state.token });
    } catch (error) { /* 忽略 */ }
  }

  // ---------------------------------------------------------------- 动作

  function selectSession(id) {
    state.selected = id;
    localStorage.setItem(LS.selected, id);
    render();
  }

  function stopSession(id) {
    if (!id) { alert("请先选择一个会话"); return; }
    var session = state.sessions.get(id);
    if (!canControl(session, "cancel")) {
      alert(agentName(session) + " 会话仅观测，不能中断");
      return;
    }
    api("/api/cancel", { method: "POST", body: { sessionId: id } })
      .then(function (r) { if (!r.ok) alert("中断失败: " + (r.error || "")); })
      .catch(function (e) { alert("中断失败: " + e.message); });
  }

  function submitAnswer(eventId) {
    var card = document.querySelector('[data-event="' + eventId + '"]');
    if (!card) return;
    var blocks = card.querySelectorAll(".q");
    var answers = [];
    if (!blocks.length) {
      var input = card.querySelector(".customInput");
      answers.push({ id: "single", selected: [], custom: input ? input.value.trim() : "" });
    } else {
      blocks.forEach(function (block, index) {
        var qid = block.getAttribute("data-qid") || ("q" + index);
        var checked = [];
        block.querySelectorAll(".option input:checked").forEach(function (item) { checked.push(item.value); });
        var customInput = block.querySelector(".customInput");
        var answer = { id: qid, selected: checked };
        if (customInput && customInput.value.trim()) answer.custom = customInput.value.trim();
        answers.push(answer);
      });
    }
    api("/api/answer", { method: "POST", body: { eventId: eventId, answers: answers } })
      .then(function (r) {
        if (!r.ok) { alert("提交失败: " + (r.error || "")); return; }
        state.pending.delete(eventId);
        renderPending();
      })
      .catch(function (e) { alert("提交失败: " + e.message); });
  }

  function answerApproval(eventId, value) {
    api("/api/answer", { method: "POST", body: { eventId: eventId, approval: value } })
      .then(function (r) {
        if (!r.ok) { alert("提交失败: " + (r.error || "")); return; }
        state.pending.delete(eventId);
        renderPending();
      })
      .catch(function (e) { alert("提交失败: " + e.message); });
  }

  function cancelPending(eventId) {
    api("/api/answer", { method: "POST", body: { eventId: eventId, cancel: true } })
      .then(function () { state.pending.delete(eventId); renderPending(); })
      .catch(function (e) { alert("取消失败: " + e.message); });
  }

  function classify(text) {
    var t = text.replace(/[\s。！!，,]/g, "").toLowerCase();
    if (/^(停止|中断|取消|停下|别做了|stop)$/.test(t)) return "stop";
    if (/^(确认|同意|好的|好|可以|允许|批准|yes|ok)$/.test(t)) return "approve";
    if (/^(拒绝|不行|不允许|驳回|no)$/.test(t)) return "reject";
    if (/^(继续|接着|往下|continue|goon)$/.test(t)) return "continue";
    return "prompt";
  }

  function send() {
    var text = dom.input.value.trim();
    if (!text) return;
    var intent = classify(text);
    var pendingList = [];
    state.pending.forEach(function (p) { pendingList.push(p); });

    if (intent === "stop") {
      var stopTarget = state.sessions.get(state.selected);
      if (!canControl(stopTarget, "cancel")) {
        alert(agentName(stopTarget) + " 会话仅观测，不能中断");
        return;
      }
      dom.input.value = "";
      stopSession(state.selected);
      return;
    }
    if (intent === "approve" || intent === "reject") {
      var target = pendingList.filter(function (p) { return p.kind === "approval"; })[0];
      if (target) {
        dom.input.value = "";
        answerApproval(target.eventId, intent === "approve" ? "allowed-once" : "rejected");
        return;
      }
    }
    if (intent === "continue") text = "继续";

    if (!state.selected) { alert("请先选择一个会话"); return; }
    var targetSession = state.sessions.get(state.selected);
    if (!canControl(targetSession, "prompt")) {
      alert(agentName(targetSession) + " 会话仅观测，不能发送指令");
      return;
    }
    var sessionId = state.selected;
    dom.input.value = "";
    api("/api/prompt", { method: "POST", body: { sessionId: sessionId, text: text, mode: "queue" } })
      .then(function (r) { if (!r.ok) alert("发送失败: " + (r.error || "")); })
      .catch(function (e) { alert("发送失败: " + e.message); });
  }

  function startDictation() {
    var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      alert("当前浏览器不支持语音识别。安卓 Chrome / 桌面 Chrome / Edge 可用；iOS Safari 请升级到较新版本。");
      return;
    }
    var recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    var base = dom.input.value;
    recognition.onresult = function (event) {
      var text = "";
      for (var i = event.resultIndex; i < event.results.length; i += 1) text += event.results[i][0].transcript;
      dom.input.value = (base ? base + " " : "") + text;
    };
    recognition.onend = function () { dom.btnMic.classList.remove("listening"); };
    recognition.onerror = function (event) {
      dom.btnMic.classList.remove("listening");
      if (event.error === "not-allowed") alert("麦克风权限被拒绝，请在浏览器设置中允许。");
    };
    dom.btnMic.classList.add("listening");
    try { recognition.start(); } catch (e) { dom.btnMic.classList.remove("listening"); }
  }

  // ---------------------------------------------------------------- 绑定

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("button[data-act]") : null;
    if (button) {
      var act = button.getAttribute("data-act");
      var id = button.getAttribute("data-id");
      var eventId = button.getAttribute("data-event");
      if (act === "select") selectSession(id);
      else if (act === "detail") openDetail(id);
      else if (act === "stop") { if (confirm("确定中断这个会话？")) stopSession(id); }
      else if (act === "continue") { selectSession(id); dom.input.value = "继续"; send(); }
      else if (act === "answer") submitAnswer(eventId);
      else if (act === "cancelPending") cancelPending(eventId);
      else if (act === "approve") answerApproval(eventId, button.getAttribute("data-value"));
      return;
    }
    var detailLine = event.target.closest ? event.target.closest("[data-detail]") : null;
    if (detailLine) {
      openDetail(detailLine.getAttribute("data-detail"));
      return;
    }
    var card = event.target.closest ? event.target.closest(".card[data-id]") : null;
    if (card) selectSession(card.getAttribute("data-id"));
  });

  if (dom.btnRepair) {
    dom.btnRepair.addEventListener("click", function () {
      if (LIVE) {
        try { localStorage.removeItem("mo-agent.live"); } catch (error) { /* 忽略 */ }
        if (SHELL_ORIGIN) location.replace(SHELL_ORIGIN + "/?stay=1"); else location.reload();
        return;
      }
      if (!confirm("清除当前连接，重新扫码配对？")) return;
      localStorage.removeItem("mo-agent.base");
      localStorage.removeItem("mo-agent.token");
      localStorage.removeItem("mo-agent.seq");
      location.reload();
    });
  }

  dom.btnSend.addEventListener("click", send);
  dom.input.addEventListener("keydown", function (event) { if (event.key === "Enter") send(); });
  dom.btnMic.addEventListener("click", startDictation);
  if (dom.btnGoLive) dom.btnGoLive.addEventListener("click", goLive);
  dom.btnRefresh.addEventListener("click", function () { if (LIVE) { location.reload(); return; } boot(); });
  dom.onlyActive.addEventListener("change", function () { state.onlyActive = dom.onlyActive.checked; renderSessions(); });

  dom.btnSpeak.addEventListener("click", function () {
    state.speak = !state.speak;
    localStorage.setItem(LS.speak, state.speak ? "1" : "0");
    // 原生壳里且还没配对过：必须给地址输入框，光有配对码无法定位电脑
  if (dom.addrInput) {
    if (NATIVE && (!BASE || connFailed)) dom.addrInput.classList.remove("hidden");
    else dom.addrInput.classList.add("hidden");
  }
  if (dom.pairHint && NATIVE && !BASE) {
    dom.pairHint.textContent = "请先扫码配对；扫不了时填写电脑地址 + 配对码。";
  }

  dom.btnSpeak.textContent = "朗读:" + (state.speak ? "开" : "关");
  });

  dom.btnNotify.addEventListener("click", function () {
    if (typeof Notification === "undefined") { alert("当前浏览器不支持系统通知，请改用 Chrome 并添加到主屏幕。"); return; }
    Notification.requestPermission().then(function (permission) {
      dom.btnNotify.textContent = permission === "granted" ? "通知已开" : "通知被拒";
    });
  });

  dom.btnPair.addEventListener("click", function () {
    var pin = dom.pinInput.value.trim();
    var target = BASE;
    if (!target && NATIVE) {
      var raw = (dom.addrInput && dom.addrInput.value ? dom.addrInput.value : "").trim();
      if (!raw) { dom.pairError.textContent = "请先扫码，或填写电脑地址（如 192.168.1.5:7788）"; return; }
      target = (/^https?:\/\//i.test(raw) ? raw : "http://" + raw).replace(/\/+$/, "");
    }
    if (!pin) { dom.pairError.textContent = "请输入 6 位配对码"; return; }
    dom.pairError.textContent = "";
    fetch(target + "/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: pin })
    }).then(function (res) { return res.json(); }).then(function (result) {
      if (!result.ok) { dom.pairError.textContent = result.error || "配对失败"; return; }
      state.token = result.token;
      localStorage.setItem(LS.token, result.token);
      if (target) localStorage.setItem("mo-agent.base", target);
      localStorage.setItem(LS.seq, "0");
      location.reload();
    }).catch(function (error) { dom.pairError.textContent = error.message; });
  });

  if (dom.btnDetailClose) dom.btnDetailClose.addEventListener("click", closeDetail);
  if (dom.btnPrevTurn) dom.btnPrevTurn.addEventListener("click", showNewer);
  if (dom.btnNextTurn) dom.btnNextTurn.addEventListener("click", showOlder);
  if (dom.detailOverlay) {
    dom.detailOverlay.addEventListener("click", function (event) {
      if (event.target === dom.detailOverlay) closeDetail();
    });

    var swipeStart = null;
    dom.detailOverlay.addEventListener("touchstart", function (event) {
      if (!state.detailId || event.touches.length !== 1) return;
      swipeStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }, { passive: true });
    dom.detailOverlay.addEventListener("touchend", function (event) {
      if (!swipeStart || !event.changedTouches || !event.changedTouches.length) return;
      var touch = event.changedTouches[0];
      var dx = touch.clientX - swipeStart.x;
      var dy = touch.clientY - swipeStart.y;
      swipeStart = null;
      // 只认横向手势，避免和上下滚动抢。
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      // 右滑 -> 上一轮（轮数变小）；左滑 -> 下一轮（轮数变大）
      if (dx > 0) showOlder();
      else showNewer();
    }, { passive: true });
  }
  document.addEventListener("keydown", function (event) {
    if (!state.detailId) return;
    if (event.key === "Escape") closeDetail();
    else if (event.key === "ArrowLeft") showNewer();
    else if (event.key === "ArrowRight") showOlder();
  });

  document.querySelectorAll(".quick").forEach(function (button) {
    button.addEventListener("click", function () {
      var quick = button.getAttribute("data-quick");
      if (quick === "status") {
        var s = state.sessions.get(state.selected);
        if (!s) { alert("请先选择一个会话"); return; }
        var info = STATUS[s.status] || STATUS.idle;
        alert("状态：" + info.label + "\n标题：" + (s.title || "") + "\n最近一轮：" + (s.lastResponse || "（无）"));
      }
    });
  });

  window.addEventListener("online", function () { if (state.es) state.es.close(); boot(); });
  window.addEventListener("focus", function () { if (!state.online) boot(); });

  // ---------------------------------------------------------------- 启动

  var repairPrompted = false;

  function markConnectionFailed() {
    if (connFailed) return;
    connFailed = true;
    renderLink();
    // 原生壳里：连不上就把扫码界面推到用户面前，别让他自己猜
    if (!NATIVE || repairPrompted) return;
    repairPrompted = true;
    setTimeout(function () {
      if (!connFailed) return;
      if (dom.addrInput) dom.addrInput.classList.remove("hidden");
      if (dom.pairHint) dom.pairHint.textContent = "连不上原来那台电脑（地址 " + BASE.replace(/^https?:\/\//, "") + "）。重新扫码，或填写新地址 + 配对码。";
      dom.pairOverlay.classList.remove("hidden");
    }, 6000);
  }

  // 手机相机扫到 mo-agent://pair 时，Android 把这个 URL 交给本 App；
  // 这里直接完成配对，用户不用再进 App 手动扫一次。
  function handleDeepLink(url) {
    if (!url || String(url).indexOf("mo-agent://") !== 0) return;
    var baseUrl = "";
    var token = "";
    try {
      var q = new URLSearchParams(String(url).split("?")[1] || "");
      baseUrl = q.get("u") || "";
      token = q.get("t") || "";
    } catch (error) { return; }
    if (!baseUrl || !token) return;
    fetch(baseUrl + "/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ qrToken: token })
    }).then(function (res) { return res.json(); }).then(function (result) {
      if (!result || !result.ok) { alert("配对失败：" + ((result && result.error) || "未知错误")); return; }
      localStorage.setItem(LS.token, result.token);
      localStorage.setItem("mo-agent.base", baseUrl);
      localStorage.removeItem(LS.seq);
      location.replace(location.pathname);
    }).catch(function (error) {
      alert("连不上 " + baseUrl + "：" + error.message);
    });
  }

  function initDeepLink() {
    // 实时界面不需要 Capacitor 桥（深链只在配对壳里有意义）。
    // 在外部源的页面上调桥接 API 容易失败，而它抛出的错误是跨源的、会被脱敏，
    // 只会变成噪音。
    if (LIVE) return;
    var App = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) || null;
    if (!App) return;
    try { App.addListener("appUrlOpen", function (event) { handleDeepLink(event && event.url); }); } catch (error) { /* 忽略 */ }
    try {
      App.getLaunchUrl().then(function (result) { if (result && result.url) handleDeepLink(result.url); });
    } catch (error) { /* 忽略 */ }
  }

  // 跳到电脑上的实时界面：页面来自电脑 → 以后改 app/web 只要刷新，不用重装 APK
  function goLive() {
    if (!BASE) return;
    // 记住：用户主动进过实时界面，以后启动直接进
    try { localStorage.setItem("mo-agent.live", "1"); } catch (error) { /* 忽略 */ }
    var url = BASE + "/?live=1&shell=" + encodeURIComponent(location.origin) + "&v=" + Date.now();
    if (state.token) url += "&t=" + encodeURIComponent(state.token);
    location.replace(url);
  }

  function maybeGoLive() {
    if (LIVE || STAY || !NATIVE || !BASE) return;
    if (!AUTO_LIVE) return; // 首次配对后留在本机界面，等用户自己点「进入实时界面」
    fetch(BASE + "/api/health", { cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("health " + res.status); return res.json(); })
      .then(function () { goLive(); })
      .catch(function () { /* 电脑不可达：留在壳里，由「连不上」提示接管 */ });
  }

  function boot() {
    if (!state.token) {
      // 若服务端关闭了鉴权，pair 会直接放行，免去手动输入配对码。
      fetch(BASE + "/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        .then(function (res) { return res.json(); })
        .then(function (result) {
          if (!result.ok) { showPair(); return; }
          state.token = result.token;
          localStorage.setItem(LS.token, result.token);
  boot();
        })
        .catch(function () { showPair(); });
      return;
    }
    api("/api/state").then(function (result) {
      if (!result.ok) { setConn(false); return; }
      applySnapshot(result.state);
      setConn(true);
      if (connFailed) { connFailed = false; renderLink(); }
      loadRemoteBuild();
      connect();
    }).catch(function (error) {
      setConn(false, "无法连接");
      if (String(error && error.message) !== "未配对") {
        markConnectionFailed();
        setTimeout(boot, 4000);
      }
    });
  }

  // 原生壳里且还没配对过：必须给地址输入框，光有配对码无法定位电脑
  if (dom.addrInput) {
    if (NATIVE && (!BASE || connFailed)) dom.addrInput.classList.remove("hidden");
    else dom.addrInput.classList.add("hidden");
  }
  if (dom.pairHint && NATIVE && !BASE) {
    dom.pairHint.textContent = "请先扫码配对；扫不了时填写电脑地址 + 配对码。";
  }

  dom.btnSpeak.textContent = "朗读:" + (state.speak ? "开" : "关");
  dom.onlyActive.checked = state.onlyActive;

  cleanupServiceWorker();

  // 连接状态栏要在「连接失败」时也能看见——不能只挂在 render() 里
  renderLink();
  loadLocalBuild();
  loadRemoteBuild();
  // 尽早把地址/令牌交给前台服务，避免切到「实时界面」后原生长连接没起来
  startNativeNotify();
  maybeGoLive();
  initDeepLink();

  boot();
})();
