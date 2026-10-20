import fs from "node:fs";
import { grantAdminCookie, isAdminAuthed } from "./admin-auth.mjs";

// 日志只给本机看：host 默认绑 0.0.0.0，若不限制，同网段手机也能读到日志。
export function isLoopback(req) {
  const raw = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
  return raw === "" || raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1";
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 启动横幅、二维码等会往日志里写终端 ANSI 色码（\x1b[47m 之类），
// 直接显示到网页会变成乱码，这里统一剥掉。
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, "");
}

/** 只读文件尾部若干行：日志可能很大，读最后 256KB 足够。 */
export function readTail(file, maxLines) {
  try {
    const stat = fs.statSync(file);
    const bytes = Math.min(stat.size, 256 * 1024);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buf, 0, bytes, start);
      let text = buf.subarray(0, read).toString("utf8");
      // 从文件中部截断时，第一行可能是半行，丢掉
      if (start > 0) {
        const nl = text.indexOf("\n");
        text = nl >= 0 ? text.slice(nl + 1) : "";
      }
      text = stripAnsi(text);
      const all = text.split(/\r?\n/);
      if (all.length && all[all.length - 1] === "") all.pop();
      return {
        lines: all.slice(-maxLines),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return {
      lines: [],
      size: 0,
      updatedAt: null,
      error: error && error.message ? error.message : String(error),
    };
  }
}

const STYLE = [
  ":root{color-scheme:dark}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:#0b1020;color:#e7ecff;font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif;display:flex;flex-direction:column;height:100vh}",
  "header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #263054;background:#111931}",
  "header h1{font-size:14px;margin:0;white-space:nowrap}",
  ".path{color:#8b97bd;font-size:12px;word-break:break-all;flex:1;min-width:0}",
  ".btn{cursor:pointer;border:1px solid #263054;background:#141b32;color:#e7ecff;border-radius:8px;padding:5px 12px;font-size:12.5px}",
  ".btn:hover{border-color:#4f8cff}",
  ".dot{width:8px;height:8px;border-radius:50%;background:#35d39a;display:inline-block;flex:none}",
  ".dot.off{background:#f5b942}",
  "pre{flex:1;margin:0;padding:14px 16px;overflow:auto;font:12px/1.6 'SF Mono',Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all}",
  "pre.empty{color:#8b97bd}",
].join("");

const SCRIPT = [
  "(function(){",
  "var pre=document.getElementById('log');",
  "var pathEl=document.getElementById('path');",
  "var dot=document.getElementById('dot');",
  "var toggle=document.getElementById('toggle');",
  "var auto=true;",
  "function nearBottom(){return pre.scrollHeight-pre.scrollTop-pre.clientHeight<60;}",
  "function render(d){",
  "  if(d.path)pathEl.textContent=d.path;",
  "  dot.className='dot'+(d.error?' off':'');",
  "  var text=(d.lines&&d.lines.length)?d.lines.join('\\n'):'';",
  "  var atBottom=nearBottom();",
  "  pre.textContent=text||'(暂无日志…)';",
  "  pre.className=text?'':'empty';",
  "  if(atBottom&&auto)pre.scrollTop=pre.scrollHeight;",
  "}",
  "function tick(){",
  "  if(!auto)return;",
  "  fetch('/logs/data?lines=400',{cache:'no-store'}).then(function(r){return r.json();}).then(render).catch(function(){dot.className='dot off';});",
  "}",
  "toggle.addEventListener('click',function(){auto=!auto;toggle.textContent=auto?'暂停':'继续';if(auto)tick();});",
  "document.getElementById('refresh').addEventListener('click',function(){auto=true;toggle.textContent='暂停';tick();});",
  "tick();setInterval(tick,1500);",
  "})();",
].join("");

function page(file) {
  return [
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />",
    "<meta name='viewport' content='width=device-width, initial-scale=1' />",
    "<title>mo-agent · 日志</title><style>" + STYLE + "</style></head><body>",
    "<header><span id='dot' class='dot'></span><h1>日志</h1>",
    "<span class='path' id='path'>" + escapeHtml(file) + "</span>",
    "<button class='btn' id='refresh'>刷新</button>",
    "<button class='btn' id='toggle'>暂停</button></header>",
    "<pre id='log' class='empty'>加载中…</pre>",
    "<script>" + SCRIPT + "</script></body></html>",
  ].join("");
}

/** 处理 /logs 与 /logs/data；已处理返回 true。 */
export async function handleLogRoutes(req, res, url, ctx) {
  const pathname = url.pathname;
  if (pathname !== "/logs" && pathname !== "/logs/data") return false;
  if (req.method !== "GET") {
    json(res, 405, { ok: false, error: "method not allowed" });
    return true;
  }
  if (!isLoopback(req)) {
    json(res, 403, { ok: false, error: "日志仅本机可访问" });
    return true;
  }
  if (!isAdminAuthed(req, url, ctx.localToken)) {
    if (pathname === "/logs/data") {
      json(res, 401, { ok: false, error: "缺少或无效的本机令牌" });
      return true;
    }
    res.writeHead(401, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    });
    res.end("<!doctype html><html lang='zh-CN'><head><meta charset='utf-8' />"
      + "<meta name='viewport' content='width=device-width, initial-scale=1' />"
      + "<title>mo-agent · 需要本机鉴权</title><style>" + STYLE + "</style></head><body>"
      + "<header><span class='dot off'></span><h1>日志</h1></header>"
      + "<pre class='empty'>需要本机鉴权：请从 mo-agent 菜单栏的「查看日志」打开。</pre>"
      + "</body></html>");
    return true;
  }
  grantAdminCookie(req, res, ctx.localToken, url);

  const file = ctx.logFile;
  const requested = Number(url.searchParams.get("lines"));
  const maxLines = Math.min(Math.max(Number.isFinite(requested) ? requested : 400, 20), 5000);

  if (pathname === "/logs/data") {
    const tail = readTail(file, maxLines);
    json(res, 200, { ok: true, path: file, ...tail });
    return true;
  }

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  });
  res.end(page(file));
  return true;
}
