/**
 * 远程批准 UI（独立模块，不侵入 app.js）。
 * 监听 approval.pending / approval.resolved，渲染授权卡片并回填决定。
 */
(function () {
  'use strict';

  var BASE = localStorage.getItem('mo-agent.base') || '';

  var token = '';

  var approvals = new Map();
  var section = null;
  var list = null;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ago(ts) {
    if (!ts) return '';
    var delta = Date.now() - ts;
    if (delta < 60000) return Math.max(1, Math.round(delta / 1000)) + ' 秒前';
    if (delta < 3600000) return Math.round(delta / 60000) + ' 分钟前';
    return Math.round(delta / 3600000) + ' 小时前';
  }

  function build() {
    section = document.createElement('section');
    section.id = 'approvalSection';
    section.className = 'pending hidden';
    section.innerHTML = '<h2>需要你决定</h2><div id="approvalList"></div>';
    var main = document.getElementById('main');
    if (main) main.insertBefore(section, main.firstChild);
    else document.body.appendChild(section);
    list = document.getElementById('approvalList');
  }

  // ---- 任务卡确认（mo task confirm 发起的请求，与工具授权是两套）----
  var taskApprovals = new Map();
  var taskSection = null;
  var taskList = null;

  function buildTaskSection() {
    taskSection = document.createElement('section');
    taskSection.id = 'taskApprovalSection';
    taskSection.className = 'pending hidden';
    taskSection.innerHTML = '<h2>任务卡确认</h2><div id="taskApprovalList"></div>';
    var main = document.getElementById('main');
    if (main) main.insertBefore(taskSection, main.firstChild);
    else document.body.appendChild(taskSection);
    taskList = document.getElementById('taskApprovalList');
  }

  function renderTasks() {
    var items = [];
    taskApprovals.forEach(function (item) { items.push(item); });
    if (!items.length) {
      taskSection.classList.add('hidden');
      taskList.innerHTML = '';
      return;
    }
    taskSection.classList.remove('hidden');
    taskList.innerHTML = items.map(function (item) {
      var parts = [];
      parts.push('<div class="card attention">');
      parts.push('<div class="cardTop"><div class="cardTitle">确认任务卡 · ' + esc(item.title || item.taskId) + '</div><span class="badge waiting">需要你批准</span></div>');
      parts.push('<div class="meta">' + esc(item.taskId) + ' · 指纹 ' + esc(String(item.cardHash || '').slice(0, 8)) + ' · ' + esc(item.expiresAt ? '有效至 ' + item.expiresAt.replace('T', ' ').slice(0, 16) : '') + '</div>');
      if (item.requestedBy && item.requestedBy.from) parts.push('<div class="meta">来自 ' + esc(item.requestedBy.from) + '</div>');
      parts.push('<div class="qText">批准后主 Agent 才能派发这张卡；批准前改卡会让这次批准失效。</div>');
      parts.push('<div class="cardActions">');
      parts.push('<button class="ok" data-task-id="' + esc(item.id) + '" data-task-decision="approve">允许</button>');
      parts.push('<button class="no" data-task-id="' + esc(item.id) + '" data-task-decision="reject">拒绝</button>');
      parts.push('</div></div>');
      return parts.join('');
    }).join('');
  }

  function loadTasks() {
    return fetch(BASE + '/api/task-approvals', { headers: { 'x-mo-agent-token': token } })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (result && result.ok && result.pending) {
          taskApprovals.clear();
          result.pending.forEach(function (item) { taskApprovals.set(item.id, item); });
          renderTasks();
        }
      })
      .catch(function () { /* 忽略 */ });
  }

  function decideTask(id, decision) {
    fetch(BASE + '/api/task-approvals/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mo-agent-token': token },
      body: JSON.stringify({ decision: decision })
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (result && result.ok) {
          taskApprovals.delete(id);
          renderTasks();
        } else {
          alert('提交失败: ' + ((result && result.error) || '未知错误'));
          loadTasks();
        }
      })
      .catch(function (error) { alert('提交失败: ' + error.message); });
  }

  /** 把 toolInput 展开成可读全文：命令/路径优先，其余字段用 JSON 补全。 */
  function formatToolInput(input) {
    if (input == null) return '';
    if (typeof input !== 'object') return String(input);
    var lines = [];
    var rest = {};
    Object.keys(input).forEach(function (key) {
      if (key === 'command') {
        if (typeof input[key] === 'string') lines.push(input[key]);
        else rest[key] = input[key];
      } else if (key === 'file_path') {
        if (typeof input[key] === 'string') lines.push(input[key]);
        else rest[key] = input[key];
      } else {
        rest[key] = input[key];
      }
    });
    if (Object.keys(rest).length) {
      if (lines.length) lines.push('');
      lines.push(JSON.stringify(rest, null, 2));
    }
    return lines.length ? lines.join('\n') : JSON.stringify(input, null, 2);
  }

  function render() {
    var items = [];
    approvals.forEach(function (a) { items.push(a); });
    if (!items.length) {
      section.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    section.classList.remove('hidden');
    list.innerHTML = items.map(function (a) {
      if (a.questions && a.questions.length) return renderQuestion(a);
      var parts = [];
      parts.push('<div class="card attention">');
      parts.push('<div class="cardTop"><div class="cardTitle">等待授权 · ' + esc(a.agentLabel || a.agent || 'Agent') + '</div><span class="badge waiting">需要你决定</span></div>');
      parts.push('<div class="meta">' + esc(a.toolName || '') + ' · ' + ago(a.createdAt) + '</div>');
      parts.push('<div class="qText">' + esc(a.title || a.toolName || '该操作需要你的授权') + '</div>');
      if (a.toolInput) parts.push('<pre class="approvalInput">' + esc(formatToolInput(a.toolInput)) + '</pre>');
      parts.push('<div class="cardActions">');
      parts.push('<button class="ok" data-approval-id="' + esc(a.id) + '" data-approval-decision="allow_once">允许一次</button>');
      parts.push('<button data-approval-id="' + esc(a.id) + '" data-approval-decision="allow_always">总是允许</button>');
      parts.push('<button class="no" data-approval-id="' + esc(a.id) + '" data-approval-decision="reject_once">拒绝</button>');
      parts.push('</div></div>');
      return parts.join('');
    }).join('');
  }

  /** AskUserQuestion：渲染问题与选项，提交时把答案回填到 updatedInput.answers。 */
  function renderQuestion(a) {
    var parts = [];
    parts.push('<div class="card attention" data-approval-card="' + esc(a.id) + '">');
    parts.push('<div class="cardTop"><div class="cardTitle">等待回答 · ' + esc(a.agentLabel || a.agent || 'Agent') + '</div><span class="badge waiting">需要你回答</span></div>');
    parts.push('<div class="meta">' + esc(a.sessionTitle || a.toolName || '') + ' · ' + ago(a.createdAt) + '</div>');
    a.questions.forEach(function (q, index) {
      parts.push('<div class="q" data-question="' + esc(q.question) + '">');
      if (q.header) parts.push('<div class="qHeader">' + esc(q.header) + '</div>');
      parts.push('<div class="qText">' + esc(q.question) + '</div>');
      var type = q.multiSelect ? 'checkbox' : 'radio';
      var name = 'qa_' + a.id + '_' + index;
      parts.push('<div class="options">');
      (q.options || []).forEach(function (opt) {
        parts.push('<label class="option"><input type="' + type + '" name="' + esc(name) + '" data-answer-option="1" value="' + esc(opt.label) + '" />');
        parts.push('<span>' + esc(opt.label) + (opt.description ? ' · <span class="meta">' + esc(opt.description) + '</span>' : '') + '</span></label>');
      });
      parts.push('</div>');
      parts.push('<input class="customInput" data-answer-custom="1" placeholder="或输入自定义回答" />');
      parts.push('</div>');
    });
    parts.push('<div class="cardActions">');
    parts.push('<button class="ok" data-approval-submit="' + esc(a.id) + '">提交回答</button>');
    parts.push('<button class="no" data-approval-id="' + esc(a.id) + '" data-approval-decision="reject_once">拒绝</button>');
    parts.push('</div></div>');
    return parts.join('');
  }

  /** 从卡片里收集 { 问题原文: 答案 }；多选取值用逗号拼接（与 CLI 的 answers 约定一致）。 */
  function collectAnswers(card) {
    var answers = {};
    var blocks = card ? card.querySelectorAll('[data-question]') : [];
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      var question = block.getAttribute('data-question') || '';
      var custom = block.querySelector('input[data-answer-custom]');
      var checked = block.querySelectorAll('input[data-answer-option]:checked');
      var values = [];
      for (var j = 0; j < checked.length; j += 1) values.push(checked[j].value);
      var value = custom && custom.value.trim() ? custom.value.trim() : values.join(', ');
      if (question && value) answers[question] = value;
    }
    return answers;
  }

  function load() {
    fetch(BASE + '/api/state', { headers: { 'x-mo-agent-token': token } })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (result && result.ok && result.state && result.state.approvals) {
          result.state.approvals.forEach(function (a) { approvals.set(a.id, a); });
          render();
        }
      })
      .catch(function () { /* 忽略 */ });
  }

  function decide(id, decision, answers) {
    var body = { id: id, decision: decision, clientAt: Date.now(), source: 'app' };
    if (answers && Object.keys(answers).length) body.answers = answers;
    fetch(BASE + '/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mo-agent-token': token },
      body: JSON.stringify(body)
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (result && result.ok) { approvals.delete(id); render(); }
        else alert('提交失败: ' + ((result && result.error) || '未知错误'));
      })
      .catch(function (error) { alert('提交失败: ' + error.message); });
  }

  function connect() {
    var since = Number(localStorage.getItem('mo-agent.seq') || 0) || 0;
    var es = new EventSource(BASE + '/api/events?since=' + encodeURIComponent(since)
      + '&token=' + encodeURIComponent(token));
    // 统一信封：按 evt.type 分发，不再逐个 addEventListener。
    es.onmessage = function (event) {
      var evt;
      try { evt = JSON.parse(event.data); } catch (e) { return; }
      var p = evt.payload || {};
      if (evt.type === 'approval.pending') {
        approvals.set(p.id, p);
        render();
        // 通知由 host 的 core/notify.mjs 统一发出（notify 事件），此处不再重复弹
      } else if (evt.type === 'approval.resolved') {
        approvals.delete(p.id);
        render();
      }
    };
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest) return;
    var submit = event.target.closest('button[data-approval-submit]');
    if (submit) {
      var card = submit.closest('.card');
      var answers = collectAnswers(card);
      if (!Object.keys(answers).length) {
        alert('请先选择或输入答案');
        return;
      }
      decide(submit.getAttribute('data-approval-submit'), 'allow_once', answers);
      return;
    }
    var taskButton = event.target.closest('button[data-task-decision]');
    if (taskButton) {
      decideTask(taskButton.getAttribute('data-task-id'), taskButton.getAttribute('data-task-decision'));
      return;
    }
    var button = event.target.closest('button[data-approval-decision]');
    if (!button) return;
    decide(button.getAttribute('data-approval-id'), button.getAttribute('data-approval-decision'));
  });

  function start() {
    token = localStorage.getItem('mo-agent.token') || '';
    if (!token) { setTimeout(start, 1000); return; }
    build();
    load();
    connect();
    buildTaskSection();
    loadTasks();
    // 任务确认是文件队列，没有事件推送，靠轮询
    setInterval(loadTasks, 5000);
  }

  start();
})();
