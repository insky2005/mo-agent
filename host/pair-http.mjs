import QRCode from "qrcode";
import { buildPairPayload, candidateAddresses } from "./pairing.mjs";
import { localIPv4List } from "./http.mjs";

function html(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
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
  "h1{font-size:20px;margin:0 0 2px}",
  ".sub{color:#8b97bd;font-size:13px;margin-bottom:22px}",
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
].join("");

/** 处理 /pair、/setup 及其二维码；已处理返回 true。 */
export async function handlePairRoutes(req, res, url, ctx) {
  const pathname = url.pathname;
  const known = pathname === "/pair" || pathname === "/setup" || pathname.startsWith("/setup/qr/") || pathname === "/pair/qr.svg" || pathname === "/setup/status" || pathname === "/setup/renew";
  if (!known) return false;
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

  // 配对成功 / 快过期时页面自己换新码，不依赖用户手动刷新
  const pollScript = [
    "<script>(function(){",
    "var base=" + ctx.pairing.status().redeemedCount + ";",
    "var banner=document.getElementById('pairedBanner');",
    "var ttlEl=document.getElementById('ttl');",
    "var stopped=false;",
    "function tick(){",
    "  if(stopped)return;",
    "  fetch('/setup/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){",
    "    if(!s||!s.ok)return;",
    "    if(s.redeemedCount>base){stopped=true;if(banner)banner.style.display='block';setTimeout(function(){location.reload();},1200);return;}",
    "    if(s.remainingMs<=0){location.reload();return;}",
    "    var sec=Math.round(s.remainingMs/1000);var m=Math.floor(sec/60);var r2=sec%60;",
    "    if(ttlEl)ttlEl.textContent=m+':'+(r2<10?'0':'')+r2;",
    "  }).catch(function(){});",
    "}",
    "setInterval(tick,1500);",
    "})();</script>"
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
    "<p id='pairedBanner' style='display:none;color:#35d19a;font-weight:600;margin-top:10px'>✓ 配对成功，正在换新的配对码…</p>",
    "<p style='margin-top:12px;min-height:0'>有效期 <b id='ttl'>" + ttlMinutes + ":00</b> · 用一次即失效 · <a href='/setup/renew'>换一个配对码</a></p>",
    "</div>",
    "</div>",
    "</div>",
    "<div class='meta'>配对码 <b>" + escapeHtml(ctx.pin) + "</b>（也可以手动输入）",
    "<div class='ips'>" + buttons + "</div></div>",
    "<div class='warn'>手机连不上时，多半是二维码里选错了网卡——点上面的地址，切换成和手机同一网段的那个。</div>",
    pollScript,
  ].join("");

  html(res, 200, page);
  return true;
}
