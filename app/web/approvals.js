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
      var parts = [];
      parts.push('<div class="card attention">');
      parts.push('<div class="cardTop"><div class="cardTitle">等待授权 · ' + esc(a.agentLabel || a.agent || 'Agent') + '</div><span class="badge waiting">需要你决定</span></div>');
      parts.push('<div class="meta">' + esc(a.toolName || '') + ' · ' + ago(a.createdAt) + '</div>');
      parts.push('<div class="qText">' + esc(a.title || a.toolName || '该操作需要你的授权') + '</div>');
      if (a.toolInput) parts.push('<div class="meta">' + esc(JSON.stringify(a.toolInput).slice(0, 200)) + '</div>');
      parts.push('<div class="cardActions">');
      parts.push('<button class="ok" data-approval-id="' + esc(a.id) + '" data-approval-decision="allow_once">允许一次</button>');
      parts.push('<button data-approval-id="' + esc(a.id) + '" data-approval-decision="allow_always">总是允许</button>');
      parts.push('<button class="no" data-approval-id="' + esc(a.id) + '" data-approval-decision="reject_once">拒绝</button>');
      parts.push('</div></div>');
      return parts.join('');
    }).join('');
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

  function decide(id, decision) {
    fetch(BASE + '/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mo-agent-token': token },
      body: JSON.stringify({ id: id, decision: decision })
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
      + '&envelope=1&token=' + encodeURIComponent(token));
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
    var button = event.target.closest ? event.target.closest('button[data-approval-decision]') : null;
    if (!button) return;
    decide(button.getAttribute('data-approval-id'), button.getAttribute('data-approval-decision'));
  });

  function start() {
    token = localStorage.getItem('mo-agent.token') || '';
    if (!token) { setTimeout(start, 1000); return; }
    build();
    load();
    connect();
  }

  start();
})();
