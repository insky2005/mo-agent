import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import { buildPairPayload, candidateAddresses } from "./pairing.mjs";
import { localIPv4List } from "./http.mjs";
import { grantAdminCookie, isAdminAuthed } from "./admin-auth.mjs";

// 管理页只接受回环地址 + 本机令牌；写操作还要求本进程发出的表单令牌，
// 防止用户浏览其它网站时被跨站 POST 改 hook。
const HOOKS_CSRF = randomBytes(16).toString("hex");

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

function deniedPage(res, status, title, detail) {
  html(res, status,
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />"
    + "<meta name='viewport' content='width=device-width, initial-scale=1' />"
    + "<title>mo-agent · 需要本机鉴权</title><style>" + STYLE + "</style></head><body>"
    + "<h1>" + escapeHtml(title) + "</h1>"
    + "<div class='sub'>" + escapeHtml(detail) + "</div>"
    + "<div class='warn'>这些页面只允许在电脑本机、并且通过 mo-agent 的菜单打开。"
    + "请从菜单栏打开「设置 → App 安装与配对」或「一键配置 Agent…」。</div>"
    + "</body></html>");
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function redirect(res, location) {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

function readForm(req) {
  return new Promise((resolve) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      const params = new URLSearchParams(data);
      const out = {};
      for (const [key, value] of params) out[key] = value;
      resolve(out);
    });
    req.on("error", () => resolve({}));
  });
}

function svg(res, payload) {
  return QRCode.toString(payload, { type: "svg", margin: 1, width: 420 }).then((markup) => {
    res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
    res.end(markup);
  });
}

function pickAddress(requested, ctx) {
  const list = candidateAddresses(localIPv4List());
  if (requested && list.some((item) => item.address === requested)) return requested;
  if (ctx.preferredAddress && list.some((item) => item.address === ctx.preferredAddress)) return ctx.preferredAddress;
  return list.length ? list[0].address : "127.0.0.1";
}

function baseFor(address, port) {
  return "http://" + address + ":" + port;
}

const STYLE = [
  ":root{color-scheme:dark}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:#0b1020;color:#e7ecff;font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif;",
  "display:flex;flex-direction:column;align-items:center;padding:28px 18px 40px;min-height:100vh}",
  "a{color:#8ab4ff}",
  "h1{font-size:20px;margin:0 0 2px}",
  ".sub{color:#8b97bd;font-size:13px;margin-bottom:22px;text-align:center}",
  ".grid{display:flex;gap:22px;flex-wrap:wrap;justify-content:center}",
  ".card{background:#141b32;border:1px solid #263054;border-radius:16px;padding:18px;width:320px;text-align:center}",
  ".card h2{font-size:15px;margin:0 0 4px;color:#e7ecff}",
  ".card p{color:#8b97bd;font-size:12.5px;line-height:1.6;margin:6px 0 14px;min-height:52px}",
  ".qr{background:#fff;padding:12px;border-radius:12px;line-height:0;display:inline-block}",
  ".qr svg,.qr img{width:240px;height:240px;display:block}",
  ".step{display:inline-block;font-size:11px;color:#0b1020;background:#4f8cff;border-radius:999px;padding:2px 9px;margin-bottom:8px;font-weight:700}",
  ".step.b{background:#35d39a}",
  ".meta{margin-top:26px;color:#8b97bd;font-size:12.5px;text-align:center;line-height:1.9}",
  ".meta b{color:#e7ecff;letter-spacing:3px;font-size:18px}",
  ".ips{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:10px;max-width:560px}",
  ".ip{padding:6px 11px;border:1px solid #263054;border-radius:9px;color:#8b97bd;text-decoration:none;font-size:12.5px}",
  ".ip.on{border-color:#4f8cff;color:#e7ecff}",
  ".warn{margin-top:20px;color:#f5b942;font-size:12px;max-width:620px;text-align:center;line-height:1.7}",
  ".panel{background:#141b32;border:1px solid #263054;border-radius:16px;padding:18px;margin-top:22px;width:100%;max-width:720px}",
  ".panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-bottom:6px}",
  ".panel-head h2{font-size:15px;margin:0 0 6px}",
  ".panel-head p{color:#8b97bd;font-size:12.5px;line-height:1.6;margin:0;max-width:450px}",
  ".agent-list{margin-top:6px}",
  ".agent{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:16px 0;",
  "border-top:1px solid #202a49;flex-wrap:wrap}",
  ".agent-list .agent:first-child{border-top:0;padding-top:14px}",
  ".agent-main{min-width:0;flex:1}",
  ".agent-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px}",
  ".agent-id{color:#8b97bd;font-size:11.5px;font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
  ".agent-path{color:#8b97bd;font-size:12px;margin-top:6px;word-break:break-all;line-height:1.7}",
  ".agent-path code{color:#cdd7f7;font-size:11.5px}",
  ".agent-events{color:#8b97bd;font-size:12px;margin-top:6px;line-height:1.8}",
  ".agent-error{color:#ffb3ba;font-size:12px;margin-top:6px;line-height:1.7}",
  ".badge{font-size:11px;border-radius:999px;padding:2px 9px;border:1px solid transparent;white-space:nowrap}",
  ".badge.ok{background:rgba(53,211,154,.14);color:#35d39a;border-color:rgba(53,211,154,.4)}",
  ".badge.warn{background:rgba(245,185,66,.14);color:#f5b942;border-color:rgba(245,185,66,.4)}",
  ".badge.off{background:rgba(139,151,189,.12);color:#8b97bd;border-color:#263054}",
  ".agent-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".btn{display:inline-block;border:1px solid #3b5bdb;background:#3b5bdb;color:#fff;border-radius:9px;padding:7px 13px;",
  "font-size:12.5px;cursor:pointer;text-decoration:none;font-weight:600;font-family:inherit}",
  ".btn:hover{filter:brightness(1.1)}",
  ".btn.ghost{background:transparent;color:#aab6dc;border-color:#33406a;font-weight:500}",
  ".btn.danger{background:transparent;border-color:#6b2b3a;color:#f0858f}",
  ".btn[disabled]{opacity:.45;cursor:not-allowed}",
  ".banner{margin-top:18px;border-radius:12px;padding:11px 14px;font-size:13px;line-height:1.6;border:1px solid;width:100%;max-width:720px}",
  ".banner.ok{background:rgba(53,211,154,.12);border-color:rgba(53,211,154,.4);color:#8ef0c6}",
  ".banner.bad{background:rgba(240,133,143,.12);border-color:rgba(240,133,143,.4);color:#ffb3ba}",
  ".note{color:#8b97bd;font-size:12px;margin-top:14px;line-height:1.9}",
  ".note code{color:#cdd7f7}",
  ".config-title{font-size:11.5px;color:#8b97bd;margin-top:10px}",
  ".config-list{margin-top:6px;display:flex;flex-direction:column;gap:6px}",
  ".config-item{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;background:#10162a;border:1px solid #1f2947;",
  "border-radius:9px;padding:7px 10px}",
  ".config-item.done{border-color:rgba(53,211,154,.3)}",
  ".config-event{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#cdd7f7}",
  ".config-desc{color:#aab6dc;font-size:12px;flex:1;min-width:150px}",
  ".config-meta{color:#8b97bd;font-size:11px;white-space:nowrap}",
  "details.config-detail{margin-top:9px}",
  "details.config-detail summary{cursor:pointer;color:#8b97bd;font-size:11.5px}",
  "pre{background:#0d1326;border:1px solid #1f2947;border-radius:9px;padding:10px;overflow:auto;font-size:11px;",
  "line-height:1.6;margin:6px 0 0;color:#cdd7f7;white-space:pre-wrap;word-break:break-all}",
].join("");

/** 处理 /pair、/setup、/agents 及其二维码；已处理返回 true。 */
export async function handlePairRoutes(req, res, url, ctx) {
  const pathname = url.pathname;
  const applyPath = pathname === "/setup/hooks/apply";
  const dingtalkPath = pathname === "/setup/dingtalk" || pathname.startsWith("/setup/dingtalk/");
  const known = applyPath
    || dingtalkPath
    || pathname === "/pair"
    || pathname === "/setup"
    || pathname === "/agents"
    || pathname.startsWith("/setup/qr/")
    || pathname === "/pair/qr.svg"
    || pathname === "/setup/status"
    || pathname === "/setup/renew";
  if (!known) return false;

  // ---- 管理页保护：只允许回环地址 + 本机令牌 ----
  // 外网 / 局域网一律拒绝，避免设置页、配对二维码和 hooks 写操作暴露在网络上；
  // 即使在本机，也要带 host 生成的本机令牌（桌面壳打开时自动附加）。
  if (ctx.isLoopback === false) {
    deniedPage(res, 403, "仅限电脑本机", "该页面不允许从局域网或外网访问。");
    return true;
  }
  if (!isAdminAuthed(req, url, ctx.localToken)) {
    deniedPage(res, 401, "需要本机鉴权", "缺少或无效的本机令牌。");
    return true;
  }
  grantAdminCookie(req, res, ctx.localToken, url);

  // ---- Agent hooks 一键配置（只允许电脑本机；手机/局域网不能改） ----
  if (applyPath) {
    if (req.method !== "POST") {
      html(res, 405, "method not allowed");
      return true;
    }
    if (ctx.isLoopback === false) {
      html(res, 403, "该操作仅限电脑本机：请在电脑浏览器打开 http://127.0.0.1:" + ctx.port + "/agents");
      return true;
    }
    if (!ctx.hooksManager) {
      html(res, 503, "配置管理不可用（hooks manager 未加载）");
      return true;
    }
    const form = await readForm(req);
    if (form.csrf !== HOOKS_CSRF) {
      html(res, 403, "页面已过期：请刷新 /agents 后重试");
      return true;
    }
    const action = form.action === "uninstall" ? "uninstall" : "install";
    const agentId = String(form.agentId || "all");
    let results = [];
    let thrown = "";
    try {
      results = ctx.hooksManager.apply({ agentId, action });
    } catch (error) {
      thrown = error && error.message ? error.message : String(error);
    }
    const summary = summarize(results, action, thrown);
    const query = new URLSearchParams({ msg: summary.msg, bad: summary.bad ? "1" : "0" });
    redirect(res, "/agents?" + query.toString());
    return true;
  }

  if (pathname === "/agents") {
    if (req.method !== "GET") {
      html(res, 405, "method not allowed");
      return true;
    }
    renderAgentsPage(res, url, ctx);
    return true;
  }

  if (dingtalkPath) {
    return handleDingTalkRoutes(req, res, url, ctx);
  }

  if (req.method !== "GET") {
    html(res, 405, "method not allowed");
    return true;
  }

  const address = pickAddress(url.searchParams.get("ip"), ctx);
  const baseUrl = baseFor(address, ctx.port);
  // 打开/刷新设置页就换一张新码：页面上的码永远是可用的
  const issued = pathname === "/setup" ? ctx.pairing.issue() : ctx.pairing.peek();
  const pairPayload = buildPairPayload(baseUrl, issued.token);
  // 带版本参数：每个构建一个独立 URL，避免手机下载器复用同名旧包
  const installUrl = baseUrl + "/app.apk" + (ctx.apkVersionCode ? "?v=" + ctx.apkVersionCode : "");

  if (pathname === "/setup/status") {
    // 注意：必须返回 true。json() 返回 undefined，
    // 若直接 return json(...) 调用方会以为"没处理"，继续走到静态文件分支重复写响应头。
    json(res, 200, Object.assign({ ok: true }, ctx.pairing.status()));
    return true;
  }
  if (pathname === "/setup/renew") {
    if (typeof ctx.renewPairing === "function") ctx.renewPairing(); else ctx.pairing.issue();
    res.writeHead(302, { location: "/setup", "cache-control": "no-store" });
    res.end();
    return true;
  }

  if (pathname === "/pair/qr.svg" || pathname === "/setup/qr/pair.svg") return svg(res, pairPayload).then(() => true);
  if (pathname === "/setup/qr/install.svg") return svg(res, installUrl).then(() => true);

  const list = candidateAddresses(localIPv4List());
  const buttons = list
    .map((item) => '<a class="ip' + (item.address === address ? " on" : "") + '" href="/setup?ip=' + encodeURIComponent(item.address) + '">' + escapeHtml(item.address) + " · " + escapeHtml(item.name) + "</a>")
    .join("");
  const ttlMinutes = Math.round((ctx.pairing.ttlMs || 300000) / 60000);

  // 配对成功 / 快过期时页面自己换新码，不依赖用户手动刷新；
  // 配对成功后直接把这个设置窗口关掉（桌面端），浏览器里则退化成刷新出新码。
  const pollScript = [
    "<script>(function(){",
    "var base=" + ctx.pairing.status().redeemedCount + ";",
    "var banner=document.getElementById('pairedBanner');",
    "var ttlEl=document.getElementById('ttl');",
    "var stopped=false;",
    "function closePanel(){",
    "  if(window.__electrobunSendToHost){try{window.__electrobunSendToHost({type:'panel-close'});}catch(err){}}",
    "  try{window.close();}catch(err){}",
    "}",
    "function tick(){",
    "  if(stopped)return;",
    "  fetch('/setup/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){",
    "    if(!s||!s.ok)return;",
    "    if(s.redeemedCount>base){",
    "      stopped=true;",
    "      if(banner){banner.textContent='✓ 配对成功，正在关闭窗口…';banner.style.display='block';}",
    "      closePanel();",
    "      setTimeout(function(){location.reload();},1500);",
    "      return;",
    "    }",
    "    if(s.remainingMs<=0){location.reload();return;}",
    "    var sec=Math.round(s.remainingMs/1000);var m=Math.floor(sec/60);var r2=sec%60;",
    "    if(ttlEl)ttlEl.textContent=m+':'+(r2<10?'0':'')+r2;",
    "  }).catch(function(){});",
    "}",
    "setInterval(tick,1500);",
    "})();</script>"
  ].join("");

  const escScript = [
    "<script>(function(){",
    "document.addEventListener('keydown',function(e){",
    "  if(e.key!=='Escape')return;",
    "  if(window.__electrobunSendToHost){try{window.__electrobunSendToHost({type:'panel-close'});return;}catch(err){}}",
    "  try{window.close();}catch(err){}",
    "});",
    "})();</script>",
  ].join("");
  const page = [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />",
    "<meta name='viewport' content='width=device-width, initial-scale=1' />",
    "<title>mo-agent 设置</title><style>" + STYLE + "</style></head><body>",
    "<h1>mo-agent</h1><div class='sub'>手机扫两下就能用</div>",
    "<div class='grid'>",
    "<div class='card'><div class='step'>第 1 步</div><h2>装 App</h2>",
    "<p>用手机相机或扫码工具扫描，下载 APK 后按提示安装（需要允许「安装未知来源应用」）。</p>",
    "<div class='qr'><img src='/setup/qr/install.svg?ip=" + encodeURIComponent(address) + "' alt='install qr' width='240' height='240' /></div>",
    "<p style='margin-top:12px;min-height:0'>" + (ctx.apkExists ? "安装包已就绪 · " + ctx.apkSizeText + (ctx.apkVersionText ? " · " + ctx.apkVersionText : "") : "尚未打包 APK，先跑 scripts/build-android.sh") + "</p>",
    "</div>",
    "<div class='card'><div class='step b'>第 2 步</div><h2>配对</h2>",
    "<p>用手机相机直接扫这个码（已装 App 会跳进来自动配对）；也可以在 App 里点「扫码配对」。</p>",
    "<div class='qr'><img src='/setup/qr/pair.svg?ip=" + encodeURIComponent(address) + "' alt='pair qr' width='240' height='240' /></div>",
    "<p id='pairedBanner' style='display:none;color:#35d19a;font-weight:600;margin-top:10px'>✓ 配对成功，正在关闭窗口…</p>",
    "<p style='margin-top:12px;min-height:0'>有效期 <b id='ttl'>" + ttlMinutes + ":00</b> · 用一次即失效 · <a href='/setup/renew'>换一个配对码</a></p>",
    "</div>",
    "</div>",
    "<div class='meta'>配对码 <b>" + escapeHtml(ctx.pin) + "</b>（也可以手动输入）",
    "<div class='ips'>" + buttons + "</div></div>",
    "<div class='warn'>手机连不上时，多半是二维码里选错了网卡——点上面的地址，切换成和手机同一网段的那个。</div>",
    pollScript,
    escScript,
  ].join("");

  html(res, 200, page);
  return true;
}

function handleDingTalkRoutes(req, res, url, ctx) {
  const pathname = url.pathname;
  if (pathname === "/setup/dingtalk") {
    if (req.method !== "GET") {
      html(res, 405, "method not allowed");
      return true;
    }
    renderDingTalkPage(res);
    return true;
  }

  if (pathname === "/setup/dingtalk/qr.svg") {
    const status = ctx.dingtalkSetup ? ctx.dingtalkSetup.status() : null;
    if (!status || !status.verificationUriComplete) {
      json(res, 404, { ok: false, error: "no-qr" });
      return true;
    }
    return svg(res, status.verificationUriComplete).then(() => true);
  }

  if (pathname === "/setup/dingtalk/status") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    const bot = ctx.dingtalk || null;
    json(res, 200, {
      ok: true,
      onboarding: ctx.dingtalkSetup ? ctx.dingtalkSetup.status() : { state: "unavailable" },
      bot: bot && typeof bot.getState === "function" ? bot.getState() : null,
    });
    return true;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method not allowed" });
    return true;
  }
  if (req.headers["x-mo-agent-local"] !== "1") {
    json(res, 403, { ok: false, error: "missing local header" });
    return true;
  }

  (async () => {
    try {
      if (pathname === "/setup/dingtalk/onboard/start") {
        if (!ctx.dingtalkSetup) throw new Error("钉钉扫码创建不可用");
        json(res, 200, await ctx.dingtalkSetup.start());
        return;
      }
      if (pathname === "/setup/dingtalk/onboard/cancel") {
        if (ctx.dingtalkSetup) ctx.dingtalkSetup.cancel();
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === "/setup/dingtalk/bind/start") {
        if (!ctx.dingtalk) throw new Error("钉钉通道未配置");
        json(res, 200, ctx.dingtalk.startBinding());
        return;
      }
      if (pathname === "/setup/dingtalk/bind/confirm") {
        if (!ctx.dingtalk) throw new Error("钉钉通道未配置");
        json(res, 200, { ok: await ctx.dingtalk.confirmBinding() });
        return;
      }
      if (pathname === "/setup/dingtalk/bind/reset") {
        if (ctx.dingtalk) ctx.dingtalk.unbind();
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      json(res, 400, { ok: false, error: error && error.message ? error.message : String(error) });
    }
  })();
  return true;
}

function renderDingTalkPage(res) {
  const script = [
    "<script>(function(){",
    "function $(id){return document.getElementById(id)}",
    "function post(path){return fetch(path,{method:'POST',cache:'no-store',headers:{'x-mo-agent-local':'1'}}).then(function(r){return r.json()})}",
    "function render(s){",
    "  var on=s.onboarding||{}, bot=s.bot||{};",
    "  var st=on.state||'idle';",
    "  var text={idle:'未配置',qr_waiting:'正在生成二维码',polling:'等待扫码',done:'应用已创建',error:'失败：'+(on.error||'')}[st]||st;",
    "  if(bot.configured){text=bot.connected?'已连接':'已配置（未连接）';}",
    "  $('state').textContent=text;",
    "  $('qrWrap').style.display=(st==='polling'&&on.verificationUriComplete)?'block':'none';",
    "  if(st==='polling')$('qr').src='/setup/dingtalk/qr.svg?ts='+Date.now();",
    "  var b=bot.binding||{};",
    "  $('bindState').textContent=b.state==='bound'?('已绑定 '+(b.userId||'')):b.state==='waiting'?'等待首条消息':b.state==='pending_confirm'?'待确认 '+(b.pendingNick||''):'未绑定';",
    "  $('start').style.display=bot.configured?'none':'inline-block';",
    "  $('start').disabled=false;",
    "  $('bind').style.display=(bot.configured&&b.state==='unbound')?'inline-block':'none';",
    "  $('confirm').style.display=b.state==='pending_confirm'?'inline-block':'none';",
    "  $('reset').style.display=bot.configured?'inline-block':'none';",
    "}",
    "function refresh(){fetch('/setup/dingtalk/status',{cache:'no-store'}).then(function(r){return r.json()}).then(render).catch(function(){})}",
    "$('start').onclick=function(){$('start').disabled=true;post('/setup/dingtalk/onboard/start').then(render).then(refresh).catch(function(){})};",
    "$('bind').onclick=function(){post('/setup/dingtalk/bind/start').then(refresh)};",
    "$('confirm').onclick=function(){post('/setup/dingtalk/bind/confirm').then(refresh)};",
    "$('reset').onclick=function(){if(confirm('解除绑定？'))post('/setup/dingtalk/bind/reset').then(refresh)};",
    "refresh();setInterval(refresh,2000);",
    "})();</script>",
  ].join("");
  const page = [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />",
    "<meta name='viewport' content='width=device-width, initial-scale=1' />",
    "<title>mo-agent · 钉钉通道</title><style>" + STYLE + "</style></head><body>",
    "<h1>钉钉通道</h1><div class='sub'>扫码自动创建应用与机器人；不装 APK 也能在手机钉钉里收审批。</div>",
    "<div class='card'>",
    "<p>状态：<b id='state'>加载中…</b></p>",
    "<p>绑定：<b id='bindState'>—</b></p>",
    "<p><button class='ip' id='start' type='button'>扫码创建机器人</button></p>",
    "<div id='qrWrap' style='display:none'><div class='qr'><img id='qr' alt='dingtalk qr' width='240' height='240' /></div>",
    "<p style='min-height:0'>用手机钉钉扫码，确认创建并授权。</p></div>",
    "<p><button class='ip' id='bind' type='button' style='display:none'>开始绑定</button>",
    "<button class='ip' id='confirm' type='button' style='display:none'>确认绑定</button>",
    "<button class='ip' id='reset' type='button' style='display:none'>解绑</button></p>",
    "<p class='warn' style='margin-top:14px'>绑定：点「开始绑定」后，在钉钉里给机器人发任意一句话，再回这里确认。</p>",
    "</div>",
    "<div class='meta'><a href='/setup'>← 返回设置</a></div>",
    script,
  ].join("");
  html(res, 200, page);
}

function summarize(results, action, thrown) {
  if (thrown) return { msg: thrown, bad: true };
  const failed = results.filter((item) => !item.ok);
  if (failed.length) {
    return { msg: failed.map((item) => (item.label || item.id) + "：" + item.error).join("；"), bad: true };
  }
  const changed = results.filter((item) => item.changed);
  if (!changed.length) return { msg: "配置没有变化（已经是最新的）", bad: false };
  const names = changed.map((item) => item.label || item.id).join("、");
  if (action === "uninstall") return { msg: "已移除 " + names + " 的 hook 配置；原配置已备份。", bad: false };
  return { msg: "已配置 " + names + "；重启对应 Agent 后生效。原配置已备份。", bad: false };
}

function statusBadge(item) {
  if (item.error) return { cls: "warn", text: "读取失败" };
  if (item.installed && item.outdated) return { cls: "warn", text: "需要更新" };
  if (item.installed) return { cls: "ok", text: "已配置" };
  if (item.events && item.events.some((event) => event.installed)) return { cls: "warn", text: "部分配置" };
  return { cls: "off", text: "未配置" };
}

function configRow(event) {
  const state = event.installed ? (event.outdated ? "路径待更新" : "已配置") : "未配置";
  const cls = event.installed && !event.outdated ? " done" : "";
  return "<div class='config-item" + cls + "'>"
    + "<span class='config-event'>" + escapeHtml(event.event) + "</span>"
    + (event.label ? "<span class='config-desc'>" + escapeHtml(event.label) + "</span>" : "")
    + "<span class='config-meta'>超时 " + escapeHtml(String(event.timeout)) + "s · " + state + "</span>"
    + "</div>";
}

function renderAgentRow(item, canWrite) {
  const supported = !!item.supported;
  const badge = supported
    ? statusBadge(item)
    : { cls: "off", text: item.kind === "native" ? "无需配置" : "暂不支持" };
  const title = "<div class='agent-title'><strong>" + escapeHtml(item.label) + "</strong>"
    + "<span class='badge " + badge.cls + "'>" + badge.text + "</span>"
    + "<span class='agent-id'>" + escapeHtml(item.id) + (item.enabled === false ? " · 档案未启用" : "") + "</span></div>";
  const error = supported && item.error ? "<div class='agent-error'>" + escapeHtml(item.error) + "</div>" : "";
  const runner = supported && item.runnerMissing
    ? "<div class='agent-error'>找不到 hook 入口：<code>" + escapeHtml(item.cliPath) + "</code>，请重新构建或安装 mo-agent。</div>"
    : "";
  let detail = "";
  if (supported) {
    const paths = Array.isArray(item.settingsPaths) && item.settingsPaths.length
      ? item.settingsPaths
      : [item.settingsPath || ""];
    const pathLine = "<div class='agent-path'>配置文件：<code>"
      + paths.map((file) => escapeHtml(file)).join("</code>、<code>") + "</code>"
      + (item.exists ? "" : "（将创建）") + "</div>";
    const config = item.events && item.events.length
      ? "<div class='config-title'>将写入的配置（只动 hooks 字段，其它设置原样保留）</div>"
        + "<div class='config-list'>" + item.events.map(configRow).join("") + "</div>"
      : "";
    const commands = item.events && item.events.length
      ? "<details class='config-detail'><summary>查看实际写入的命令</summary><pre>"
        + escapeHtml(item.events.map((event) => event.command).join("\n")) + "</pre></details>"
      : "";
    detail = pathLine + config + commands + error + runner;
  } else {
    detail = "<div class='agent-events'>" + escapeHtml(item.reason || "—") + "</div>";
  }
  let actions = "";
  if (supported && canWrite) {
    const installed = item.installed;
    const label = installed ? (item.outdated ? "更新配置" : "重新写入") : "一键配置";
    const anyInstalled = (item.events || []).some((event) => event.installed);
    actions = "<div class='agent-actions'>"
      + "<form method='post' action='/setup/hooks/apply'>"
      + "<input type='hidden' name='csrf' value='" + HOOKS_CSRF + "' />"
      + "<input type='hidden' name='agentId' value='" + escapeHtml(item.id) + "' />"
      + "<input type='hidden' name='action' value='install' />"
      + "<button class='btn" + (installed && !item.outdated ? " ghost" : "") + "' type='submit'"
      + (item.runnerMissing ? " disabled" : "") + ">" + label + "</button>"
      + "</form>"
      + (anyInstalled
        ? "<form method='post' action='/setup/hooks/apply' onsubmit=\"return confirm('确定要移除 " + escapeHtml(item.label) + " 的 mo-agent hook 吗？其它配置会保留。');\">"
          + "<input type='hidden' name='csrf' value='" + HOOKS_CSRF + "' />"
          + "<input type='hidden' name='agentId' value='" + escapeHtml(item.id) + "' />"
          + "<input type='hidden' name='action' value='uninstall' />"
          + "<button class='btn danger' type='submit'>移除</button>"
          + "</form>"
        : "")
      + "</div>";
  }
  return "<div class='agent'><div class='agent-main'>" + title + detail + "</div>" + actions + "</div>";
}

function renderAgentsPage(res, url, ctx) {
  const agents = ctx.hooksManager ? ctx.hooksManager.status() : [];
  // 只列当前启用的 Agent；未启用的档案不算「目前支持」。
  const visible = agents.filter((item) => item.enabled !== false);
  // 可配置的排在前面，原生接入的排在后面；不分组、不加标题。
  visible.sort((a, b) => Number(!!b.supported) - Number(!!a.supported));
  const configurable = visible.filter((item) => item.supported);
  const ready = configurable.filter((item) => item.installed && !item.outdated && !item.error);
  // 鉴权在 handlePairRoutes 入口完成：能走到这里的都是本机 + 已授权请求。
  const canWrite = true;
  const msg = url.searchParams.get("msg") || "";
  const bad = url.searchParams.get("bad") === "1";
  const escScript = [
    "<script>(function(){",
    "document.addEventListener('keydown',function(e){",
    "  if(e.key!=='Escape')return;",
    "  if(window.__electrobunSendToHost){try{window.__electrobunSendToHost({type:'panel-close'});return;}catch(err){}}",
    "  try{window.close();}catch(err){}",
    "});",
    "})();</script>",
  ].join("");

  const rows = visible.map((item) => renderAgentRow(item, canWrite)).join("");

  const topAction = configurable.length
    ? "<form method='post' action='/setup/hooks/apply'>"
      + "<input type='hidden' name='csrf' value='" + HOOKS_CSRF + "' />"
      + "<input type='hidden' name='agentId' value='all' />"
      + "<input type='hidden' name='action' value='install' />"
      + "<button class='btn' type='submit'>" + (ready.length === configurable.length ? "全部重新写入" : "一键配置全部") + "</button>"
      + "</form>"
    : "";

  const banner = msg
    ? "<div class='banner " + (bad ? "bad" : "ok") + "'>" + escapeHtml(msg) + "</div>"
    : "";
  const unavailable = ctx.hooksManager
    ? ""
    : "<div class='banner bad'>配置管理不可用：host 没有加载 hooks manager。</div>";
  const progress = configurable.length
    ? "进度：已配置 " + ready.length + " / " + configurable.length + "。"
    : "当前没有需要 hook 配置的 Agent。";

  const page = [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />",
    "<meta name='viewport' content='width=device-width, initial-scale=1' />",
    "<title>mo-agent · 一键配置</title><style>" + STYLE + "</style></head><body>",
    "<h1>一键配置</h1><div class='sub'>所有已启用的 Agent 都在这里</div>",
    banner,
    unavailable,
    "<div class='panel'>",
    "<div class='panel-head'><div><h2>Agent</h2>",
    "<p>需要 hook 的 Agent 可以一键写入；原生接入的只显示当前方式。写入前自动备份，"
      + "只增删 mo-agent 自己的 hook，其它设置原样保留；Claude Code 需要重启后才会读取新配置。</p></div>",
    topAction,
    "</div>",
    "<div class='agent-list'>" + (rows || "<div class='agent-events'>没有可显示的 Agent。</div>") + "</div>",
    "<div class='note'>" + progress
      + "设置文件损坏（不是合法 JSON）时会拒绝写入，不会覆盖你的原文件。</div>",
    "</div>",
    "<div class='meta'><a href='/setup'>← 设置（安装与配对）</a></div>",
    escScript,
  ].join("");

  html(res, 200, page);
}
