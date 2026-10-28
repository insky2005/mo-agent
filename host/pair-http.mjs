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

function readJson(req) {
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
      try { resolve(JSON.parse(data || "{}")); } catch (error) { resolve({}); }
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
  ".card{background:#141b32;border:1px solid #263054;border-radius:16px;padding:18px;width:320px;height:500px;display:flex;flex-direction:column;align-items:center;text-align:center;overflow:auto}",
  ".card.done{justify-content:center}",
  ".card.done h2{font-size:20px}",
  ".bigStatus{font-size:22px!important;color:#35d39a!important;font-weight:700;margin:22px 0!important;text-align:center;min-height:0!important}",
  ".status-card{width:662px;max-width:100%;height:500px;justify-content:center;text-align:center;overflow:hidden}",
  ".card.status-card h2{font-size:24px;margin:0 0 14px}",
  ".card.status-card p{font-size:13px;min-height:0;margin:5px 0}",
  ".card.status-card .ip{margin-top:20px}",
  ".card h2{font-size:15px;margin:0 0 4px;color:#e7ecff}",
  ".card p{color:#8b97bd;font-size:12.5px;line-height:1.6;margin:6px 0 14px;min-height:52px}",
  ".qr{background:#fff;padding:12px;border-radius:12px;line-height:0;display:inline-block}",
  ".qr svg,.qr img{width:200px;height:200px;display:block}",
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
  ".dim{opacity:.55}",
  ".sideStep{color:#8b97bd;font-size:12.5px;line-height:1.7;margin:6px 0 14px;min-height:0}",
  ".guideStep{display:flex;gap:9px;align-items:flex-start;color:#8b97bd;font-size:12.5px;line-height:1.55;margin:10px 0}",
  ".guideStep b{display:inline-flex;width:20px;height:20px;border-radius:50%;background:#1b2440;border:1px solid #2b3558;color:#8b97bd;align-items:center;justify-content:center;font-size:11px;flex:none}",
  ".guideStep.on{color:#e7ecff}",
  ".guideStep.on b{background:#4f8cff;border-color:#4f8cff;color:#0b1020}",
  ".guideStep.done{color:#a9b8d8}",
  ".guideStep.done b{background:#35d39a;border-color:#35d39a;color:#0b1020}",
  ".guideStep.dim{opacity:.45}",
  "@media (max-width:700px){#stepGrid{grid-template-columns:1fr !important}}",
  ".card .ip{background:transparent;cursor:pointer;font:inherit}",
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

export const PAGE_STYLE = STYLE;

/** 计算配对页/设置页共用的一套二维码状态。fresh=false 时沿用当前码。 */
function setupState(ctx, url, options) {
  const address = pickAddress(url.searchParams.get("ip"), ctx);
  const baseUrl = baseFor(address, ctx.port);
  const fresh = !options || options.fresh !== false;
  const issued = fresh ? ctx.pairing.issue() : ctx.pairing.peek();
  const pairPayload = buildPairPayload(baseUrl, issued.token);
  const installUrl = baseUrl + "/app.apk" + (ctx.apkVersionCode ? "?v=" + ctx.apkVersionCode : "");
  const list = candidateAddresses(localIPv4List());
  return { address, baseUrl, issued, pairPayload, installUrl, list };
}

function setupPollScript(ctx, closeOnPair) {
  return [
    "<script>(function(){",
    "var base=" + ctx.pairing.status().redeemedCount + ";",
    "var banner=document.getElementById('pairedBanner');",
    "var ttlEl=document.getElementById('ttl');",
    "var stopped=false;",
    "function closePanel(){",
    closeOnPair
      ? "  if(window.__electrobunSendToHost){try{window.__electrobunSendToHost({type:'panel-close'});}catch(err){}}"
        + "  try{window.close();}catch(err){}"
      : "  /* 设置中心里不关闭整个窗口，刷新当前 tab 即可 */",
    "}",
    "function tick(){",
    "  if(stopped)return;",
    "  fetch('/setup/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){",
    "    if(!s||!s.ok)return;",
    "    if(s.redeemedCount>base){",
    "      stopped=true;",
    "      if(banner){banner.textContent='" + (closeOnPair ? "✓ 配对成功，正在关闭窗口…" : "✓ 配对成功，正在刷新…") + "';banner.style.display='block';}",
    closeOnPair ? "      closePanel();" : "",
    "      setTimeout(function(){location.reload();},1500);",
    "      return;",
    "    }",
    "    if(s.remainingMs<=0){location.reload();return;}",
    "    var sec=Math.round(s.remainingMs/1000);var m=Math.floor(sec/60);var r2=sec%60;",
    "    if(ttlEl)ttlEl.textContent=m+':'+(r2<10?'0':'')+r2;",
    "  }).catch(function(){});",
    "}",
    "setInterval(tick,1500);",
    "})();</script>",
  ].join("");
}

function escScriptMarkup() {
  return [
    "<script>(function(){",
    "document.addEventListener('keydown',function(e){",
    "  if(e.key!=='Escape')return;",
    "  if(window.__electrobunSendToHost){try{window.__electrobunSendToHost({type:'panel-close'});return;}catch(err){}}",
    "  try{window.close();}catch(err){}",
    "});",
    "})();</script>",
  ].join("");
}

/**
 * 安装与配对内容片段。
 * mode=standalone：旧 /setup 整页用；mode=settings：/settings?tab=app 用。
 */
export function renderSetupSection(ctx, url, options = {}) {
  const mode = options.mode === "settings" ? "settings" : "standalone";
  const state = options.state || setupState(ctx, url, { fresh: options.fresh !== false });
  const address = state.address;
  const list = state.list;
  const buttons = list
    .map((item) => {
      const href = mode === "settings"
        ? "/settings?tab=app&ip=" + encodeURIComponent(item.address)
        : "/setup?ip=" + encodeURIComponent(item.address);
      return '<a class="ip' + (item.address === address ? " on" : "") + '" href="' + href + '">'
        + escapeHtml(item.address) + " · " + escapeHtml(item.name) + "</a>";
    })
    .join("");
  const ttlMinutes = Math.round((ctx.pairing.ttlMs || 300000) / 60000);
  const renewHref = mode === "settings"
    ? "/setup/renew?next=" + encodeURIComponent("/settings?tab=app")
    : "/setup/renew";

  const body = [
    "<div class='grid'>",
    "<div class='card'><div class='step'>第 1 步</div><h2>装 App</h2>",
    "<p>用手机相机或扫码工具扫描，下载 APK 后按提示安装（需要允许「安装未知来源应用」）。</p>",
    "<div class='qr'><img src='/setup/qr/install.svg?ip=" + encodeURIComponent(address) + "' alt='install qr' width='240' height='240' /></div>",
    "<p style='margin-top:12px;min-height:0'>" + (ctx.apkExists ? "安装包已就绪 · " + ctx.apkSizeText + (ctx.apkVersionText ? " · " + ctx.apkVersionText : "") : "尚未打包 APK，先跑 scripts/build-android.sh") + "</p>",
    "</div>",
    "<div class='card'><div class='step b'>第 2 步</div><h2>配对</h2>",
    "<p>用手机相机直接扫这个码（已装 App 会跳进来自动配对）；也可以在 App 里点「扫码配对」。</p>",
    "<div class='qr'><img src='/setup/qr/pair.svg?ip=" + encodeURIComponent(address) + "' alt='pair qr' width='240' height='240' /></div>",
    "<p id='pairedBanner' style='display:none;color:#35d19a;font-weight:600;margin-top:10px'>✓ 配对成功</p>",
    "<p style='margin-top:12px;min-height:0'>有效期 <b id='ttl'>" + ttlMinutes + ":00</b> · 用一次即失效 · <a href='" + renewHref + "'>换一个配对码</a></p>",
    "</div>",
    "</div>",
    "<div class='meta'>配对码 <b>" + escapeHtml(ctx.pin) + "</b>（也可以手动输入）",
    "<div class='ips'>" + buttons + "</div></div>",
    "<div class='warn'>手机连不上时，多半是二维码里选错了网卡——点上面的地址，切换成和手机同一网段的那个。</div>",
  ].join("");

  return {
    title: "App 安装与配对",
    body,
    script: setupPollScript(ctx, mode !== "settings") + (mode === "settings" ? "" : escScriptMarkup()),
  };
}

function renderSetupPage(res, ctx, url) {
  const section = renderSetupSection(ctx, url, { mode: "standalone", fresh: true });
  const page = [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />",
    "<meta name='viewport' content='width=device-width, initial-scale=1' />",
    "<title>mo-agent 设置</title><style>" + STYLE + "</style></head><body>",
    "<h1>mo-agent</h1><div class='sub'>手机扫两下就能用</div>",
    section.body,
    section.script,
  ].join("");
  html(res, 200, page);
}

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
    const base = safeHooksNext(form.next);
    redirect(res, base + (base.includes("?") ? "&" : "?") + query.toString());
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

  const state = setupState(ctx, url, { fresh: pathname === "/setup" });

  if (pathname === "/setup/status") {
    // 注意：必须返回 true。json() 返回 undefined，
    // 若直接 return json(...) 调用方会以为"没处理"，继续走到静态文件分支重复写响应头。
    json(res, 200, Object.assign({ ok: true }, ctx.pairing.status()));
    return true;
  }
  if (pathname === "/setup/renew") {
    if (typeof ctx.renewPairing === "function") ctx.renewPairing(); else ctx.pairing.issue();
    const next = safeRenewNext(url.searchParams.get("next"));
    res.writeHead(302, { location: next, "cache-control": "no-store" });
    res.end();
    return true;
  }

  if (pathname === "/pair/qr.svg" || pathname === "/setup/qr/pair.svg") return svg(res, state.pairPayload).then(() => true);
  if (pathname === "/setup/qr/install.svg") return svg(res, state.installUrl).then(() => true);

  renderSetupPage(res, ctx, url);
  return true;
}

/** 换配对码后的落点只允许两个固定页面，避免开放重定向。 */
function safeRenewNext(value) {
  return value === "/settings?tab=app" ? value : "/setup";
}

/** hook 操作的 303 落点同样只允许两个固定页面。 */
function safeHooksNext(value) {
  return value === "/settings?tab=agents" ? value : "/agents";
}

function handleDingTalkRoutes(req, res, url, ctx) {
  const pathname = url.pathname;
  if (pathname === "/setup/dingtalk") {
    if (req.method !== "GET") {
      html(res, 405, "method not allowed");
      return true;
    }
    renderDingTalkPage(res, ctx);
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
      if (pathname === "/setup/dingtalk/manual") {
        if (!ctx.dingtalkSetup) throw new Error("钉钉配置不可用");
        const body = await readJson(req);
        json(res, 200, await ctx.dingtalkSetup.saveManual(body));
        return;
      }
      if (pathname === "/setup/dingtalk/bind/start") {
        if (ctx.dingtalk) {
          json(res, 200, ctx.dingtalk.startBinding());
        } else if (ctx.dingtalkSetup) {
          json(res, 200, ctx.dingtalkSetup.startPendingBinding());
        } else {
          throw new Error("钉钉通道未配置");
        }
        return;
      }
      if (pathname === "/setup/dingtalk/bind/confirm") {
        if (!ctx.dingtalk) throw new Error("钉钉通道未配置");
        json(res, 200, { ok: await ctx.dingtalk.confirmBinding() });
        return;
      }
      if (pathname === "/setup/dingtalk/bind/reset") {
        if (ctx.dingtalk) ctx.dingtalk.unbind();
        if (ctx.dingtalkSetup && typeof ctx.dingtalkSetup.removeCredentials === "function") {
          ctx.dingtalkSetup.removeCredentials();
        }
        if (typeof ctx.onDingTalkReset === "function") ctx.onDingTalkReset();
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

export function renderDingTalkSection(ctx, mode = "standalone") {
  const script = [
    "<script>(function(){",
    "function $(id){return document.getElementById(id)}",
    "function setText(id,text){var el=$(id);if(el)el.textContent=text;}",
    "function show(id,on){var el=$(id);if(el)el.style.display=on?'inline-block':'none';}",
    "function showBlock(id,on){var el=$(id);if(el)el.style.display=on?'block':'none';}",
    "function post(path,body){var opt={method:'POST',cache:'no-store',headers:{'x-mo-agent-local':'1'}};if(body){opt.headers['content-type']='application/json';opt.body=JSON.stringify(body);}return fetch(path,opt).then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j;})})}",
    "var autoScan=false, autoBind=false, scanRetry=null;",
    "function fmtLeft(ms){var sec=Math.max(0,Math.round(ms/1000));var m=Math.floor(sec/60);var s=sec%60;return m+':'+(s<10?'0':'')+s;}",
    "function scheduleScan(delay){if(scanRetry||autoScan)return;scanRetry=setTimeout(function(){scanRetry=null;autoScan=false;startScan();},delay);}",
    "function startScan(){if(autoScan)return;autoScan=true;post('/setup/dingtalk/onboard/start').then(function(){scanRetry=null;refresh()}).catch(function(err){autoScan=false;setText('createHint','二维码生成失败：'+(err&&err.message||'未知错误')+'；3 秒后重试。');scheduleScan(3000);});}",
    "function startBind(){if(autoBind)return;autoBind=true;post('/setup/dingtalk/bind/start').then(function(){refresh()}).catch(function(err){autoBind=false;setText('pairHint','配对码生成失败：'+(err&&err.message||'未知错误'));});}",
    "function renderCreate(on,bot){",
    "  if(bot.configured){",
    "    if($('createCard'))$('createCard').className='card done';",
    "    setText('createTitle','机器人已创建');",
    "    setText('createDesc','应用和机器人已经就绪，请在右侧完成配对。');",
    "    setText('createHint','✅ 已创建');",
    "    if($('createHint'))$('createHint').className='bigStatus';",
    "    if($('manualDetails'))$('manualDetails').style.display='none';",
    "    setText('diag','');",
    "    showBlock('qrWrap',false);show('retry',false);",
    "    return;",
    "  }",
    "  if($('createCard'))$('createCard').className='card';",
    "  if($('createHint'))$('createHint').className='';",
    "  if($('manualDetails'))$('manualDetails').style.display='';",
    "  setText('createTitle','创建机器人');",
    "  setText('createDesc','用手机钉钉扫码，自动创建应用和机器人。');",
    "  show('retry',true);",
    "  if($('retry'))$('retry').textContent='重新生成二维码';",
    "  if(on.verificationUriComplete){showBlock('qrWrap',true);$('qr').src='/setup/dingtalk/qr.svg?ts='+Date.now();}else{showBlock('qrWrap',false);}",
    "  var hint='正在向钉钉申请二维码…';",
    "  if(on.expiresAt){var left=on.expiresAt-Date.now();if(left<=0&&on.state==='polling'){autoScan=false;startScan();}else hint='二维码有效期约 '+fmtLeft(left)+'；失效后会自动刷新。';}",
    "  var pmap={SCANNED:'已扫码，请在钉钉里确认创建。',CREATING:'钉钉正在创建应用…',PUBLISHING:'钉钉正在发布机器人…',APPROVING:'应用已创建，等待管理员审批…'};",
    "  if(pmap[on.progress])hint=pmap[on.progress];",
    "  if(on.state==='done')hint='应用已创建，正在启动机器人…';",
    "  if(on.state==='error'){setText('createTitle','创建失败');setText('createDesc',on.error||'未知错误');hint='3 秒后自动重试；也可以点「重新生成二维码」。';scheduleScan(3000);}",
    "  setText('createHint',hint);",
    "  var d=on.progressDetail||{};var diag='';",
    "  if(on.state==='error'||d.failReason||(d.errcode&&d.errcode!==0)){diag=[on.progress,d.status,d.failReason,d.errmsg].filter(Boolean).join(' · ');}",
    "  setText('diag',diag?'诊断：'+diag:'');",
    "}",
    "function renderPair(on,bot,b){",
    "  var pending=on.pendingBinding||{};",
    "  var code=b.code||pending.code||'';",
    "  var expires=b.expiresAt||pending.expiresAt||0;",
    "  if(!bot.configured){",
    "    setText('pairTitle','配对');",
    "    setText('pairDesc','创建完成后，直接发送下面的 6 位配对码。');",
    "    showBlock('codeWrap',true);showBlock('bindInfo',false);",
    "    if(!code){startBind();}",
    "    setText('codeBox',code||'------');",
    "    var left0=expires?expires-Date.now():0;",
    "    if(code&&left0<=0){autoBind=false;startBind();}",
    "    setText('pairHint',code?'等待左侧创建完成；配对码 '+(left0>0?'剩余 '+fmtLeft(left0):'已过期，正在刷新'):'正在生成配对码…');",
    "    show('regenPair',true);show('reset',false);",
    "    return;",
    "  }",
    "  if(b.state==='bound'){",
    "    setText('pairTitle','已绑定');",
    "    setText('pairDesc','审批会推送到这个钉钉会话。');",
    "    setText('pairHint','');",
    "    showBlock('codeWrap',false);showBlock('bindInfo',true);",
    "    setText('bindAccount','绑定账号：'+(b.userId||'—'));",
    "    setText('bindConn','钉钉连接：'+(bot.connected?'已连接':(bot.status==='reconnecting'?'重连中':'未连接')));",
    "    show('regenPair',false);show('reset',true);",
    "    return;",
    "  }",
    "  setText('pairTitle','配对');",
    "  setText('pairDesc','打开钉钉，找到机器人，直接发送下面的 6 位配对码。');",
    "  showBlock('codeWrap',true);showBlock('bindInfo',false);",
    "  if(!code){startBind();}",
    "  setText('codeBox',code||'------');",
    "  var left=expires?expires-Date.now():0;",
    "  if(left<=0&&code){autoBind=false;startBind();}",
    "  if(!bot.connected)setText('pairHint','钉钉连接还没建立，请稍等几秒再发送。');",
    "  else setText('pairHint',code?'配对码 '+(left>0?'剩余 '+fmtLeft(left):'已过期，正在刷新')+'；发错 5 次会失效。':'正在生成配对码…');",
    "  show('regenPair',true);show('reset',false);",
    "}",
    "function render(s){",
    "  var on=s.onboarding||{},bot=s.bot||{},b=bot.binding||{};",
    "  if(b.state==='bound'){",
    "    if($('stepGrid'))$('stepGrid').style.display='none';if($('boundView'))$('boundView').style.display='flex';",
    "    setText('boundAccount',b.userId||'—');",
    "    setText('boundConn',bot.connected?'已连接':(bot.status==='reconnecting'?'重连中':'未连接'));",
    "    return;",
    "  }",
    "  if($('stepGrid'))$('stepGrid').style.display='';if($('boundView'))$('boundView').style.display='none';",
    "  renderCreate(on,bot);",
    "  renderPair(on,bot,b);",
    "}",
    "function refresh(){return fetch('/setup/dingtalk/status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){render(s);return s;}).catch(function(){})}",
    "$('retry').onclick=function(){autoScan=false;startScan();};",
    "$('regenPair').onclick=function(){autoBind=false;startBind();};",
    "var unbindArmed=false,unbindTimer=null;",
    "$('unbind').onclick=function(){",
    "  var btn=$('unbind');",
    "  if(!unbindArmed){",
    "    unbindArmed=true;btn.textContent='再次点击确认清除';",
    "    unbindTimer=setTimeout(function(){unbindArmed=false;btn.textContent='解绑并清除配置';},4000);",
    "    return;",
    "  }",
    "  clearTimeout(unbindTimer);unbindArmed=false;btn.disabled=true;btn.textContent='正在清除…';",
    "  post('/setup/dingtalk/bind/reset').then(function(){return refresh();}).catch(function(err){setText('unbindHint','解绑失败：'+(err&&err.message||'未知错误'));btn.disabled=false;btn.textContent='解绑并清除配置';});",
    "};",
    "$('manualSave').onclick=function(){post('/setup/dingtalk/manual',{clientId:$('manualId').value.trim(),clientSecret:$('manualSecret').value.trim(),robotCode:$('manualRobot').value.trim()}).then(function(){refresh()}).catch(function(err){setText('diag','保存失败：'+(err&&err.message||'未知错误'));});};",
    "refresh().then(function(s){var bot=(s&&s.bot)||{},on=(s&&s.onboarding)||{};if(!bot.configured&&on.state==='idle'){startScan();}});",
    "window.addEventListener('pagehide',function(){try{fetch('/setup/dingtalk/onboard/cancel',{method:'POST',headers:{'x-mo-agent-local':'1'},keepalive:true});}catch(e){}});",
    "setInterval(refresh,2000);",
    "})();</script>",
  ].join("");
  const body = [
    "<div class='grid' id='stepGrid'>",
    "<div class='card' id='createCard'>",
    "<div class='step'>第 1 步 · 创建机器人</div>",
    "<h2 id='createTitle'>创建机器人</h2>",
    "<p id='createDesc'>用手机钉钉扫码，自动创建应用和机器人。</p>",
    "<div id='qrWrap' style='display:none;text-align:center'><div class='qr'><img id='qr' alt='dingtalk qr' width='240' height='240' /></div></div>",
    "<p id='createHint' style='min-height:0;color:#8b97bd'></p>",
    "<p id='diag' style='min-height:0;color:#6f7ca0;font-size:11px;word-break:break-all'></p>",
    "<div class='ips'><button class='ip' id='retry' type='button' style='display:none'>重新生成二维码</button></div>",
    "<details id='manualDetails' style='margin-top:14px;width:100%'>",
    "<summary style='cursor:pointer;color:#8b97bd;font-size:12px'>扫码创建失败？手动填写已有应用</summary>",
    "<p style='font-size:12px;color:#8b97bd;text-align:left'>在开发者后台创建应用 + 机器人(Stream) 并发布后，把 Client ID / Client Secret 填到这里。</p>",
    "<input id='manualId' placeholder='Client ID' style='width:100%;box-sizing:border-box;margin:4px 0;padding:8px;border-radius:8px;border:1px solid #263054;background:#0d1326;color:#e7ecff;font:inherit' />",
    "<input id='manualSecret' placeholder='Client Secret' type='password' style='width:100%;box-sizing:border-box;margin:4px 0;padding:8px;border-radius:8px;border:1px solid #263054;background:#0d1326;color:#e7ecff;font:inherit' />",
    "<input id='manualRobot' placeholder='robotCode（可选）' style='width:100%;box-sizing:border-box;margin:4px 0;padding:8px;border-radius:8px;border:1px solid #263054;background:#0d1326;color:#e7ecff;font:inherit' />",
    "<button class='ip' id='manualSave' type='button' style='margin-top:6px'>保存并连接</button>",
    "</details>",
    "</div>",
    "<div class='card'>",
    "<div class='step b'>第 2 步 · 配对</div>",
    "<h2 id='pairTitle'>配对</h2>",
    "<p id='pairDesc'>先完成左侧的「创建机器人」。</p>",
    "<div id='codeWrap' style='display:none;text-align:center'>",
    "<div id='codeBox' style='font:700 34px/1.2 ui-monospace,Menlo,monospace;letter-spacing:8px;color:#e7ecff;background:#0d1326;border:1px solid #263054;border-radius:12px;padding:14px 10px;margin:10px 0'>------</div>",
    "</div>",
    "<div id='bindInfo' style='display:none'>",
    "<p id='bindAccount' style='min-height:0;color:#c7d4f4'></p>",
    "<p id='bindConn' style='min-height:0;color:#8b97bd'></p>",
    "</div>",
    "<p id='pairHint' style='min-height:0;color:#8b97bd'></p>",
    "<div class='ips'>",
    "<button class='ip' id='regenPair' type='button' style='display:none'>重新生成配对码</button>",
    "</div>",
    "</div>",
    "</div>",
    "<div class='card status-card' id='boundView' style='display:none'>",
    "<h2>✅ 已绑定</h2>",
    "<p style='color:#8b97bd;line-height:1.8'>审批会推送到这个钉钉会话。</p>",
    "<p style='color:#c7d4f4'>应用：<b>已创建</b></p>",
    "<p style='color:#c7d4f4'>绑定账号：<b id='boundAccount'>—</b></p>",
    "<p style='color:#c7d4f4'>钉钉连接：<b id='boundConn'>—</b></p>",
    "<button class='ip' id='unbind' type='button'>解绑并清除配置</button>",
    "<p id='unbindHint' style='color:#8b97bd;font-size:11px'>解绑会同时清除本机的 Client ID/Secret，之后需要重新扫码创建。</p>",
    "</div>",
    "<details class='panel' style='max-width:840px;width:100%;text-align:left'>",
    "<summary style='cursor:pointer;color:#e7ecff;font-size:14px;font-weight:700'>操作说明</summary>",
    "<h3 style='font-size:13px;color:#e7ecff'>创建机器人</h3>",
    "<p style='font-size:12.5px;color:#8b97bd;line-height:1.8'>在钉钉里创建一个企业内部应用和机器人，用来接收审批消息。用手机钉钉扫码，按提示确认创建即可。若一直失败，可展开左侧「手动填写已有应用」，粘贴 Client ID / Client Secret。</p>",
    "<h3 style='font-size:13px;color:#e7ecff'>配对</h3>",
    "<p style='font-size:12.5px;color:#8b97bd;line-height:1.8'>打开钉钉，找到机器人，直接发送左侧显示的 6 位配对码。配对码 5 分钟内有效，连续发错 5 次会失效；只绑定第一个发送正确配对码的账号。</p>",
    "<p style='font-size:12.5px;color:#8b97bd;line-height:1.8'>收到审批时：回复「A A3F2」表示同意，回复「D A3F2」表示拒绝（A3F2 是审批消息里的短码）。</p>",
    "<h3 style='font-size:13px;color:#e7ecff'>常见问题</h3>",
    "<p style='font-size:12.5px;color:#8b97bd;line-height:1.8'>收不到审批：检查电脑是否开机、mo-agent 是否运行、钉钉是否免打扰、绑定账号是否当前登录账号。解绑后需要重新配对。</p>",
    "</details>",
  ].join("");

  return { title: "钉钉机器人", body, script };
}

function renderDingTalkPage(res, ctx) {
  const section = renderDingTalkSection(ctx, "standalone");
  const page = [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />",
    "<meta name='viewport' content='width=device-width, initial-scale=1' />",
    "<title>mo-agent · 钉钉机器人绑定</title><style>" + STYLE + "</style></head><body>",
    "<h1>钉钉机器人绑定</h1><div class='sub'>不安装 App，也能在钉钉里接收审批、回复批准或拒绝。</div>",
    section.body,
    section.script,
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

function renderAgentRow(item, canWrite, nextPath) {
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
      + "<input type='hidden' name='next' value='" + escapeHtml(nextPath) + "' />"
      + "<input type='hidden' name='action' value='install' />"
      + "<button class='btn" + (installed && !item.outdated ? " ghost" : "") + "' type='submit'"
      + (item.runnerMissing ? " disabled" : "") + ">" + label + "</button>"
      + "</form>"
      + (anyInstalled
        ? "<form method='post' action='/setup/hooks/apply' onsubmit=\"return confirm('确定要移除 " + escapeHtml(item.label) + " 的 mo-agent hook 吗？其它配置会保留。');\">"
          + "<input type='hidden' name='csrf' value='" + HOOKS_CSRF + "' />"
          + "<input type='hidden' name='agentId' value='" + escapeHtml(item.id) + "' />"
          + "<input type='hidden' name='next' value='" + escapeHtml(nextPath) + "' />"
          + "<input type='hidden' name='action' value='uninstall' />"
          + "<button class='btn danger' type='submit'>移除</button>"
          + "</form>"
        : "")
      + "</div>";
  }
  return "<div class='agent'><div class='agent-main'>" + title + detail + "</div>" + actions + "</div>";
}

export function renderAgentsSection(ctx, url, mode = "standalone") {
  const agents = ctx.hooksManager ? ctx.hooksManager.status() : [];
  // 只列当前启用的 Agent；未启用的档案不算「目前支持」。
  const visible = agents.filter((item) => item.enabled !== false);
  // 可配置的排在前面，原生接入的排在后面；不分组、不加标题。
  visible.sort((a, b) => Number(!!b.supported) - Number(!!a.supported));
  const configurable = visible.filter((item) => item.supported);
  const ready = configurable.filter((item) => item.installed && !item.outdated && !item.error);
  // 鉴权在 handlePairRoutes / handleSettingsRoutes 入口完成：能走到这里的都是本机 + 已授权请求。
  const canWrite = true;
  const msg = url.searchParams.get("msg") || "";
  const bad = url.searchParams.get("bad") === "1";
  const nextPath = mode === "settings" ? "/settings?tab=agents" : "/agents";

  const rows = visible.map((item) => renderAgentRow(item, canWrite, nextPath)).join("");

  const topAction = configurable.length
    ? "<form method='post' action='/setup/hooks/apply'>"
      + "<input type='hidden' name='csrf' value='" + HOOKS_CSRF + "' />"
      + "<input type='hidden' name='agentId' value='all' />"
      + "<input type='hidden' name='next' value='" + escapeHtml(nextPath) + "' />"
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

  const body = [
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
  ].join("");

  return { title: "Agent 配置", body, script: mode === "settings" ? "" : escScriptMarkup() };
}

function renderAgentsPage(res, url, ctx) {
  const section = renderAgentsSection(ctx, url, "standalone");
  const page = [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />",
    "<meta name='viewport' content='width=device-width, initial-scale=1' />",
    "<title>mo-agent · 一键配置</title><style>" + STYLE + "</style></head><body>",
    "<h1>一键配置</h1><div class='sub'>所有已启用的 Agent 都在这里</div>",
    section.body,
    "<div class='meta'><a href='/setup'>← 设置（安装与配对）</a></div>",
    section.script,
  ].join("");

  html(res, 200, page);
}
