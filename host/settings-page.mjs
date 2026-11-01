import { grantAdminCookie, isAdminAuthed } from "./admin-auth.mjs";
import { isLoopback } from "./logs-http.mjs";
import {
  PAGE_STYLE,
  renderAgentsSection,
  renderDingTalkSection,
  renderSetupSection,
} from "./pair-http.mjs";
import { LOGS_STYLE, renderLogViewer } from "./logs-http.mjs";

/**
 * 统一设置中心。
 *
 * 页面仍然由 host 服务端渲染；五个 tab 直接复用现有设置片段：
 *   app      -> pair-http.renderSetupSection
 *   dingtalk -> pair-http.renderDingTalkSection
 *   agents   -> pair-http.renderAgentsSection
 *   voice    -> 本文件（桌面桥）
 *   system   -> 重启卡片 + logs-http.renderLogViewer
 *
 * 只允许回环地址 + 本机令牌，和 /setup、/agents、/logs 同一套鉴权。
 */

const TABS = [
  { id: "app", label: "App 安装与配对", hint: "手机扫两下就能用" },
  { id: "dingtalk", label: "钉钉机器人", hint: "不装 App，也能在钉钉里接收审批" },
  { id: "agents", label: "Agent 配置", hint: "配置 Agent hook 与 Pi 控制扩展" },
  { id: "voice", label: "语音", hint: "语音命令、口述、测试和浮层" },
  { id: "system", label: "重启与日志", hint: "重启本地服务，并直接查看日志" },
];

const SETTINGS_STYLE = [
  "html,body{height:100%}",
  "body{display:block;padding:0;min-height:0;overflow:hidden}",
  ".settingsApp{display:grid;grid-template-columns:220px minmax(0,1fr);height:100vh;width:100%}",
  ".settingsNav{background:#0e152a;border-right:1px solid #263054;padding:22px 14px 18px;display:flex;flex-direction:column;gap:18px;min-width:0}",
  ".settingsBrand{font-size:15px;font-weight:750;letter-spacing:.02em;padding:0 10px}",
  ".settingsBrand span{display:block;margin-top:4px;color:#8b97bd;font-size:11.5px;font-weight:500;letter-spacing:.12em}",
  ".settingsNav nav{display:flex;flex-direction:column;gap:4px}",
  ".settingsNav a{display:block;padding:9px 10px;border-radius:9px;color:#aab6dc;text-decoration:none;font-size:13px;line-height:1.35;border:1px solid transparent}",
  ".settingsNav a:hover{background:#141b32;color:#e7ecff}",
  ".settingsNav a.on{background:rgba(79,140,255,.14);border-color:rgba(79,140,255,.38);color:#e7ecff;font-weight:650}",
  ".settingsFoot{margin-top:auto;color:#6f7ca0;font-size:11px;line-height:1.7;padding:0 10px}",
  ".settingsContent{overflow:auto;padding:26px 30px 44px;min-width:0}",
  ".settingsHead{max-width:860px;margin:0 auto 18px}",
  ".settingsHead h1{font-size:21px;margin:0 0 4px}",
  ".settingsHead p{color:#8b97bd;font-size:12.5px;margin:0;line-height:1.7}",
  ".settingsContent .grid,.settingsContent .panel,.settingsContent .meta,.settingsContent .warn,.settingsContent .banner{max-width:860px;margin-left:auto;margin-right:auto}",
  ".settingsContent .grid{justify-content:flex-start}",
  ".settingsContent .card{width:auto;flex:1 1 300px;height:auto;min-height:500px}",
  ".settingsContent .panel{width:100%;max-width:860px}",
  ".settingsSection{background:#141b32;border:1px solid #263054;border-radius:16px;padding:18px;max-width:860px;margin:0 auto 14px}",
  ".settingsSection h3{font-size:14px;margin:0 0 5px;color:#e7ecff}",
  ".settingsSection p{color:#8b97bd;font-size:12.5px;line-height:1.7;margin:5px 0}",
  ".settingRow{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}",
  ".settingRow .settingMain{flex:1;min-width:220px}",
  ".switch{flex:none;border:1px solid #33406a;background:#10162a;color:#aab6dc;border-radius:999px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;min-width:74px}",
  ".switch.on{border-color:rgba(53,211,154,.5);background:rgba(53,211,154,.12);color:#8ef0c6}",
  ".switch[disabled]{opacity:.45;cursor:not-allowed}",
  ".stateBadge{display:inline-block;font-size:11px;border-radius:999px;padding:2px 9px;border:1px solid #263054;color:#8b97bd;white-space:nowrap}",
  ".stateBadge.ok{background:rgba(53,211,154,.14);color:#35d39a;border-color:rgba(53,211,154,.4)}",
  ".stateBadge.warn{background:rgba(245,185,66,.14);color:#f5b942;border-color:rgba(245,185,66,.4)}",
  ".btnRow{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}",
  ".btnRow .btn[disabled],.btnRow .btn.ghost[disabled]{opacity:.45;cursor:not-allowed}",
  ".settingsBanner{margin:12px auto 0;max-width:860px;border-radius:10px;padding:9px 12px;font-size:12.5px;line-height:1.65;border:1px solid #263054;color:#aab6dc;background:#10162a}",
  ".settingsBanner.ok{background:rgba(53,211,154,.10);border-color:rgba(53,211,154,.35);color:#8ef0c6}",
  ".settingsBanner.bad{background:rgba(240,133,143,.10);border-color:rgba(240,133,143,.35);color:#ffb3ba}",
  ".settingsBanner.hidden{display:none}",
  ".voiceMeta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}",
  ".voiceMeta .kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#cdd7f7;background:#0d1326;border:1px solid #263054;border-radius:7px;padding:3px 8px}",
  ".voiceGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:10px}",
  ".voiceAction{border:1px solid #263054;background:#10162a;border-radius:11px;padding:12px;text-align:left;color:#e7ecff;font:inherit;cursor:pointer}",
  ".voiceAction:hover{border-color:#4f8cff}",
  ".voiceAction[disabled]{opacity:.45;cursor:not-allowed}",
  ".voiceAction b{display:block;font-size:13px;margin-bottom:4px}",
  ".voiceAction span{display:block;color:#8b97bd;font-size:11.5px;line-height:1.6}",
  ".restartCard{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}",
  ".restartCard .settingMain{flex:1;min-width:240px}",
  ".restartMeta{color:#6f7ca0;font-size:11px;line-height:1.9;margin-top:8px;word-break:break-all}",
  ".restartMeta code{color:#cdd7f7}",
  ".settingsLog{margin-top:16px}",
  ".logViewer{max-width:860px;margin:0 auto;height:440px}",
  "@media (max-width:760px){",
  "  .settingsApp{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}",
  "  .settingsNav{border-right:0;border-bottom:1px solid #263054;padding:14px}",
  "  .settingsNav nav{flex-direction:row;overflow-x:auto;gap:6px;padding-bottom:2px}",
  "  .settingsNav a{white-space:nowrap;font-size:12px}",
  "  .settingsBrand,.settingsFoot{display:none}",
  "  .settingsContent{padding:18px 16px 34px}",
  "  .settingsContent .card{min-height:0;flex-basis:100%}",
  "}",
].join("");

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function deniedPage(res, status, detail) {
  html(res, status,
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />"
    + "<meta name='viewport' content='width=device-width, initial-scale=1' />"
    + "<title>mo-agent · 需要本机鉴权</title><style>" + PAGE_STYLE + "</style></head><body>"
    + "<h1>需要本机鉴权</h1>"
    + "<div class='sub'>" + escapeHtml(detail) + "</div>"
    + "<div class='warn'>设置中心只允许在电脑本机、并且通过 mo-agent 的菜单打开。"
    + "请从菜单栏打开「设置」。</div>"
    + "</body></html>");
}

function tabOf(url) {
  const id = url.searchParams.get("tab") || "app";
  return TABS.some((item) => item.id === id) ? id : "app";
}

function tabMeta(id) {
  return TABS.find((item) => item.id === id) || TABS[0];
}

function commonScript() {
  return [
    "<script>(function(){",
    "var pending=new Map(),seq=0;",
    "window.__moSettingsReply=function(reply){",
    "  var item=pending.get(reply&&reply.requestId);",
    "  if(!item)return;",
    "  pending.delete(reply.requestId);",
    "  if(reply.ok)item.resolve(reply.data||{});else item.reject(new Error(reply.error||'操作失败'));",
    "};",
    "function shell(action,payload,timeoutMs){",
    "  if(typeof window.__electrobunSendToHost!=='function')return Promise.reject(new Error('desktop-bridge-unavailable'));",
    "  return new Promise(function(resolve,reject){",
    "    var requestId='req-'+(++seq);",
    "    var timer=setTimeout(function(){pending.delete(requestId);reject(new Error('timeout'));},timeoutMs||8000);",
    "    pending.set(requestId,{",
    "      resolve:function(data){clearTimeout(timer);resolve(data);},",
    "      reject:function(error){clearTimeout(timer);reject(error);}",
    "    });",
    "    try{",
    "      window.__electrobunSendToHost({type:'settings-request',requestId:requestId,action:action,payload:payload||{}});",
    "    }catch(error){clearTimeout(timer);pending.delete(requestId);reject(error);}",
    "  });",
    "}",
    "window.__moShell={available:typeof window.__electrobunSendToHost==='function',shell:shell};",
    "document.addEventListener('keydown',function(e){",
    "  if(e.key!=='Escape')return;",
    "  if(window.__electrobunSendToHost){try{window.__electrobunSendToHost({type:'panel-close'});return;}catch(err){}}",
    "  try{window.close();}catch(err){}",
    "});",
    "})();</script>",
  ].join("");
}

function renderVoiceSection() {
  const body = [
    "<div class='settingsSection'>",
    "<div class='settingRow'><div class='settingMain'><h3>启用语音</h3>",
    "<p>开启后支持语音命令、语音口述和语音审批。切换会重新加载语音组件（约 1–3 秒），不会重启服务。</p></div>",
    "<button class='switch' id='voiceToggle' type='button' role='switch' aria-checked='false' disabled>读取中…</button></div>",
    "<div class='voiceMeta'><span class='stateBadge' id='voiceState'>读取中</span><span class='hint' id='voiceHint'>正在读取桌面状态…</span></div>",
    "</div>",
    "<div class='settingsSection'>",
    "<div class='settingRow'><div class='settingMain'><h3>语音浮层</h3>",
    "<p>设置窗口打开时浮层会暂时收起；关闭设置后按这里的开关恢复。点「显示」会立即显示在设置窗口上方。</p></div>",
    "<button class='switch' id='overlayToggle' type='button' role='switch' aria-checked='false' disabled>读取中…</button></div>",
    "<div class='voiceMeta'><span class='stateBadge' id='overlayState'>读取中</span>",
    "<span>快捷键 <span class='kbd' id='overlayShortcut'>—</span></span></div>",
    "</div>",
    "<div class='settingsSection'>",
    "<h3>语音操作</h3><p>点一次、说一次。识别和结果都会显示在语音浮层里；失败时这里也会给出摘要。</p>",
    "<div class='voiceGrid'>",
    "<button class='voiceAction' type='button' data-voice-action='voice-command' disabled><b>语音命令</b><span>说一条命令，例如暂停、继续或切换关注会话。</span></button>",
    "<button class='voiceAction' type='button' data-voice-action='dictate' disabled><b>语音口述</b><span>说一段内容，先成草稿，回读确认后发送。</span></button>",
    "<button class='voiceAction' type='button' data-voice-action='voice-test' disabled><b>语音测试</b><span>走一次完整语音测试，检查麦克风、识别和播报。</span></button>",
    "</div>",
    "<div class='settingsBanner hidden' id='voiceResult'></div>",
    "</div>",
    "<div class='settingsSection'>",
    "<h3>系统权限</h3><p>首次使用语音时，macOS 会请求麦克风权限；权限被拒绝或听不到声音时，从这里重新打开。</p>",
    "<div class='btnRow'>",
    "<button class='btn ghost' type='button' data-voice-action='mic-settings' disabled>麦克风权限设置…</button>",
    "<button class='btn ghost' type='button' data-voice-action='accessibility-settings' disabled>辅助功能权限设置…</button>",
    "</div>",
    "<div class='settingsBanner hidden' id='bridgeNote'>语音控制需要在桌面 App 内操作；当前仅展示说明。</div>",
    "</div>",
  ].join("");

  const script = [
    "<script>(function(){",
    "function $(id){return document.getElementById(id)}",
    "var state={voiceEnabled:false,overlay:{preference:true,visible:false},shortcut:'—'};",
    "var bridge=window.__moShell;",
    "var busy=false;",
    "function setBanner(id,text,bad){var el=$(id);if(!el)return;if(!text){el.className='settingsBanner hidden';el.textContent='';return;}el.className='settingsBanner '+(bad?'bad':'ok');el.textContent=text;}",
    "function setBusy(on){busy=on;document.querySelectorAll('[data-voice-action]').forEach(function(button){var action=button.getAttribute('data-voice-action');var needVoice=action!=='mic-settings'&&action!=='accessibility-settings';button.disabled=on||!bridge.available||(needVoice&&!state.voiceEnabled);});",
    "  if($('voiceToggle'))$('voiceToggle').disabled=on||!bridge.available;",
    "  if($('overlayToggle'))$('overlayToggle').disabled=on||!bridge.available||!state.voiceEnabled;}",
    "function setSwitch(id,on,label){var el=$(id);if(!el)return;el.classList.toggle('on',!!on);el.setAttribute('aria-checked',on?'true':'false');el.textContent=label;}",
    "function render(s){",
    "  state=s||state;",
    "  var enabled=!!state.voiceEnabled;",
    "  var overlay=state.overlay||{preference:true,visible:false};",
    "  if($('voiceState')){$('voiceState').className='stateBadge '+(enabled?'ok':'warn');$('voiceState').textContent=enabled?'已启用':'未启用';}",
    "  if($('overlayState')){$('overlayState').className='stateBadge '+(enabled&&overlay.visible?'ok':'warn');$('overlayState').textContent=!enabled?'语音未启用':(overlay.visible?'浮层已显示':'浮层已隐藏');}",
    "  if($('overlayShortcut'))$('overlayShortcut').textContent=state.shortcut||'—';",
    "  if($('voiceHint'))$('voiceHint').textContent=enabled?'语音已开启。':'先开启语音，下面的操作才可用。';",
    "  setSwitch('voiceToggle',enabled,enabled?'已开启':'已关闭');",
    "  setSwitch('overlayToggle',!!overlay.preference,overlay.preference?'已开启':'已关闭');",
    "  if(!busy)setBusy(false);",
    "}",
    "function noBridge(){",
    "  bridge.available=false;",
    "  setBanner('bridgeNote','语音控制需要在桌面 App 内操作；当前仅展示说明。',false);",
    "  if($('voiceToggle')){$('voiceToggle').disabled=true;$('voiceToggle').textContent='仅桌面 App';}",
    "  if($('overlayToggle')){$('overlayToggle').disabled=true;$('overlayToggle').textContent='仅桌面 App';}",
    "  if($('voiceState')){$('voiceState').className='stateBadge warn';$('voiceState').textContent='不可用';}",
    "  if($('overlayState')){$('overlayState').className='stateBadge warn';$('overlayState').textContent='不可用';}",
    "  if($('overlayShortcut'))$('overlayShortcut').textContent='—';",
    "  if($('voiceHint'))$('voiceHint').textContent='普通浏览器只能查看。';",
    "  setBusy(false);",
    "}",
    "function refresh(){return bridge.shell('state',{},8000).then(function(s){render(s);return s;}).catch(function(error){var message=String(error&&error.message||'');if(message==='desktop-bridge-unavailable'){noBridge();return;}setBanner('voiceResult','读取语音状态失败：'+(message||'未知错误'),true);});}",
    "if(!bridge.available){noBridge();return;}",
    "refresh();",
    "setInterval(refresh,5000);",
    "if($('voiceToggle'))$('voiceToggle').onclick=function(){if(busy)return;setBusy(true);var next=!state.voiceEnabled;setBanner('voiceResult','正在'+(next?'启用':'停用')+'语音并重新加载语音组件…',false);bridge.shell('voice-enable',{enabled:next},65000).then(function(data){var enabled=!!(data&&data.enabled);var ready=!!(data&&data.ready);if(!enabled)setBanner('voiceResult','语音已停用。',false);else if(ready)setBanner('voiceResult','语音已启用。',false);else setBanner('voiceResult','语音已启用，但当前不可用：'+((data&&data.status)||'请查看日志'),true);setBusy(false);refresh();}).catch(function(error){setBusy(false);setBanner('voiceResult','切换失败：'+(error&&error.message||'未知错误'),true);refresh();});};",
    "if($('overlayToggle'))$('overlayToggle').onclick=function(){if(busy)return;setBusy(true);var next=!((state.overlay||{}).preference);bridge.shell('overlay',{visible:next},10000).then(function(s){state.overlay={preference:!!(s&&s.preference),visible:!!(s&&s.visible)};render(state);}).catch(function(error){setBusy(false);setBanner('voiceResult','浮层切换失败：'+(error&&error.message||'未知错误'),true);});};",
    "document.querySelectorAll('[data-voice-action]').forEach(function(button){button.onclick=function(){",
    "  var action=button.getAttribute('data-voice-action');",
    "  if(busy)return;",
    "  if(action!=='mic-settings'&&action!=='accessibility-settings'&&!state.voiceEnabled)return;",
    "  if(action==='mic-settings'||action==='accessibility-settings'){bridge.shell(action,{},8000).then(function(){setBanner('voiceResult','已打开系统设置。',false);}).catch(function(error){setBanner('voiceResult','打开失败：'+(error&&error.message||'未知错误'),true);});return;}",
    "  setBusy(true);setBanner('voiceResult','正在浮层里进行，请按提示说话…',false);",
    "  bridge.shell(action,{},200000).then(function(result){",
    "    var text=(result&&(result.reply||result.error))||'操作完成。';",
    "    var bad=!!(result&&result.ok===false);",
    "    setBanner('voiceResult',text,bad);setBusy(false);refresh();",
    "  }).catch(function(error){setBanner('voiceResult','操作失败：'+(error&&error.message||'未知错误'),true);setBusy(false);});",
    "};});",
    "})();</script>",
  ].join("");

  return { title: "语音", body, script };
}

function renderSystemSection(ctx) {
  const logFile = ctx.logFile || "";
  const viewer = renderLogViewer({ file: logFile, mode: "inline" });
  const body = [
    "<div class='settingsSection'>",
    "<div class='restartCard'><div class='settingMain'>",
    "<h3>重启本地服务</h3>",
    "<p>重启会短暂断开监控、语音和手机推送；Agent 会话本身不受影响。</p>",
    "<div class='restartMeta'>端口 <code>" + escapeHtml(ctx.port || "—") + "</code><br />日志 <code>" + escapeHtml(logFile || "—") + "</code></div>",
    "<div class='btnRow'><button class='btn danger' id='restartBtn' type='button' disabled>重启本地服务</button>",
    "<span class='stateBadge' id='restartState'>读取中</span></div>",
    "<div class='settingsBanner hidden' id='restartHint'></div>",
    "</div></div>",
    "</div>",
    "<div class='settingsLog'>" + viewer.body + "</div>",
  ].join("");

  const script = [
    "<script>(function(){",
    "var btn=document.getElementById('restartBtn');",
    "var state=document.getElementById('restartState');",
    "var hint=document.getElementById('restartHint');",
    "var bridge=window.__moShell;",
    "var armed=false,timer=null;",
    "function setHint(text,bad){if(!hint)return;if(!text){hint.className='settingsBanner hidden';hint.textContent='';return;}hint.className='settingsBanner '+(bad?'bad':'ok');hint.textContent=text;}",
    "if(!bridge.available){if(state){state.className='stateBadge warn';state.textContent='仅桌面 App';}if(btn){btn.disabled=true;btn.textContent='仅桌面 App 可重启';}setHint('重启需要桌面 App；日志仍可查看。',false);return;}",
    "if(state){state.className='stateBadge ok';state.textContent='就绪';}",
    "if(btn){btn.disabled=false;btn.onclick=function(){",
    "  if(!armed){armed=true;btn.textContent='再次点击确认重启';setHint('4 秒内再次点击确认。',false);clearTimeout(timer);timer=setTimeout(function(){armed=false;btn.textContent='重启本地服务';setHint('',false);},4000);return;}",
    "  clearTimeout(timer);armed=false;btn.disabled=true;btn.textContent='正在重启…';setHint('正在重启本地服务，窗口会自动重新打开…',false);",
    "  bridge.shell('restart',{},12000).then(function(){setHint('正在重启本地服务，窗口会自动重新打开…',false);}).catch(function(error){btn.disabled=false;btn.textContent='重启本地服务';setHint('重启失败：'+(error&&error.message||'未知错误'),true);});",
    "};}",
    "})();</script>",
  ].join("");

  return { title: "重启与日志", body, script: script + viewer.script };
}

function settingsLayout(active, section) {
  const meta = tabMeta(active);
  const links = TABS.map((item) => {
    const on = item.id === active;
    return "<a href='/settings?tab=" + item.id + "'" + (on ? " class='on' aria-current='page'" : "") + ">"
      + escapeHtml(item.label) + "</a>";
  }).join("");
  return [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />",
    "<meta name='viewport' content='width=device-width, initial-scale=1' />",
    "<title>mo-agent · 设置</title><style>" + PAGE_STYLE + LOGS_STYLE + SETTINGS_STYLE + "</style></head><body>",
    "<div class='settingsApp'>",
    "<aside class='settingsNav'><div class='settingsBrand'>mo-agent<span>SETTINGS</span></div>",
    "<nav aria-label='设置分类'>" + links + "</nav>",
    "<div class='settingsFoot'>设置只允许本机访问<br />语音与日志都在这里</div></aside>",
    "<main class='settingsContent'>",
    "<header class='settingsHead'><h1>" + escapeHtml(meta.label) + "</h1><p>" + escapeHtml(meta.hint) + "</p></header>",
    section.body,
    commonScript(),
    section.script,
    "</main></div></body></html>",
  ].join("");
}

/** 处理 /settings；已处理返回 true。 */
export async function handleSettingsRoutes(req, res, url, ctx) {
  if (url.pathname !== "/settings") return false;
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
    return true;
  }
  if (ctx.isLoopback === false || !isLoopback(req)) {
    deniedPage(res, 403, "该页面不允许从局域网或外网访问。");
    return true;
  }
  if (!isAdminAuthed(req, url, ctx.localToken)) {
    deniedPage(res, 401, "缺少或无效的本机令牌。请从 mo-agent 菜单栏打开设置。");
    return true;
  }
  grantAdminCookie(req, res, ctx.localToken, url);

  const tab = tabOf(url);
  let section;
  try {
    if (tab === "dingtalk") section = renderDingTalkSection(ctx, "settings");
    else if (tab === "agents") section = renderAgentsSection(ctx, url, "settings");
    else if (tab === "voice") section = renderVoiceSection();
    else if (tab === "system") section = renderSystemSection(ctx);
    else section = renderSetupSection(ctx, url, { mode: "settings", fresh: true });
  } catch (error) {
    html(res, 500, "<!doctype html><meta charset='utf-8' /><title>mo-agent · 设置</title>"
      + "<body style='background:#0b1020;color:#e7ecff;font-family:sans-serif;padding:24px'>"
      + "<h1>设置页渲染失败</h1><p>" + escapeHtml(error && error.message ? error.message : String(error)) + "</p></body>");
    return true;
  }

  html(res, 200, settingsLayout(tab, section));
  return true;
}
