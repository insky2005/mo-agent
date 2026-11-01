import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { handlePairRoutes } from "./pair-http.mjs";
import { createHooksManager } from "./agent-hooks.mjs";
import { adminCookieValue } from "./admin-auth.mjs";
import { fileURLToPath } from "node:url";
import { installPiExtension, piExtensionStatus, uninstallPiExtension } from "./pi-extension.mjs";

const quiet = { info() {}, warn() {} };

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-page-"));
  const home = path.join(dir, "home");
  const root = path.join(dir, "root");
  fs.mkdirSync(path.join(root, "approvals"), { recursive: true });
  fs.writeFileSync(path.join(root, "approvals", "hook-cli.mjs"), "// test stub\n");
  fs.mkdirSync(home, { recursive: true });
  return { dir, home, root, settings: path.join(home, ".claude", "settings.json") };
}

function profile() {
  return {
    id: "claude-code",
    label: "Claude Code",
    enabled: true,
    hooks: {
      kind: "claude-code",
      settingsFile: "~/.claude/settings.json",
      events: { PermissionRequest: "approval.pending", Notification: "notice" },
      labels: {
        PermissionRequest: "授权请求：手机可批准 / 拒绝",
        Notification: "通知：Agent 需要关注时推送提醒",
      },
    },
  };
}

function nativeProfile() {
  return {
    id: "dsh",
    label: "DeepSeek Harness",
    enabled: true,
    hooks: { kind: "native", events: {} },
  };
}

function disabledProfile() {
  return {
    id: "codex",
    label: "Codex CLI",
    enabled: false,
    hooks: { kind: "codex" },
  };
}

function managerFor(ws, profiles) {
  return createHooksManager({ root: ws.root, home: ws.home, profiles: profiles || [profile()], log: quiet });
}

const LOCAL_TOKEN = "test-local-token";

function context(ws, overrides) {
  return Object.assign({
    pairing: {
      issue: () => ({ token: "token" }),
      peek: () => ({ token: "token" }),
      status: () => ({ redeemedCount: 0, remainingMs: 300000, ttlMs: 300000 }),
      ttlMs: 300000,
    },
    pin: "123456",
    port: 7788,
    preferredAddress: null,
    apkExists: false,
    apkSizeText: "",
    apkVersionText: "",
    apkVersionCode: 0,
    renewPairing() {},
    hooksManager: managerFor(ws),
    localToken: LOCAL_TOKEN,
    isLoopback: true,
  }, overrides || {});
}

function fakeResponse() {
  const out = { status: 0, headers: {}, body: "" };
  const implicit = {};
  return {
    out,
    setHeader(name, value) {
      implicit[String(name).toLowerCase()] = String(value);
    },
    writeHead(status, headers) {
      out.status = status;
      out.headers = Object.assign({}, implicit, headers || {});
    },
    end(body) {
      if (body !== undefined) out.body += String(body);
    },
  };
}

function request(method, body, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (options.cookie) headers.cookie = options.cookie;
  if (body === undefined) {
    return { method, headers, socket: { remoteAddress: options.remoteAddress || "127.0.0.1" } };
  }
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: options.remoteAddress || "127.0.0.1" };
  return req;
}

function csrfOf(html) {
  const hit = String(html).match(/name='csrf' value='([a-f0-9]+)'/);
  return hit ? hit[1] : "";
}

function messageOf(location) {
  return new URLSearchParams(String(location).split("?")[1] || "").get("msg") || "";
}

async function get(pathname, ctx, options = {}) {
  const url = new URL("http://x" + pathname);
  if (options.token !== false) url.searchParams.set("token", options.token || ctx.localToken);
  const res = fakeResponse();
  const handled = await handlePairRoutes(
    request("GET", undefined, { cookie: options.cookie, remoteAddress: options.remoteAddress }),
    res,
    url,
    ctx,
  );
  return { handled, res };
}

test("/setup/dingtalk 渲染钉钉通道页", async () => {
  const ws = workspace();
  const ctx = context(ws, {
    dingtalkSetup: { status: () => ({ state: "idle" }) },
    dingtalk: null,
  });
  const { res } = await get("/setup/dingtalk", ctx);
  assert.equal(res.out.status, 200);
  assert.match(res.out.body, /钉钉机器人绑定/);
  assert.match(res.out.body, /配对码/);
  assert.match(res.out.body, /startScan/);
  const script = String(res.out.body).match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script, "页面应包含内联脚本");
  assert.doesNotThrow(() => new Function(script[1]));
});

test("/setup/dingtalk/bind/reset 同时清绑定和配置", async () => {
  const ws = workspace();
  const calls = { unbind: 0, clear: 0, reset: 0 };
  const ctx = context(ws, {
    dingtalkSetup: { status: () => ({ state: "done" }), removeCredentials: () => { calls.clear += 1; } },
    dingtalk: { unbind: () => { calls.unbind += 1; } },
    onDingTalkReset: () => { calls.reset += 1; },
  });
  const url = new URL("http://x/setup/dingtalk/bind/reset?token=" + encodeURIComponent(ctx.localToken));
  const res = fakeResponse();
  await handlePairRoutes(request("POST", "", { headers: { "x-mo-agent-local": "1" } }), res, url, ctx);
  assert.equal(res.out.status, 200);
  assert.deepEqual(calls, { unbind: 1, clear: 1, reset: 1 });
});
test("/setup/dingtalk/bind/start 需要本机头", async () => {
  const ws = workspace();
  const ctx = context(ws, {
    dingtalkSetup: { status: () => ({ state: "idle" }) },
    dingtalk: { startBinding: () => ({ ok: true, expiresAt: 1 }) },
  });
  const url = new URL("http://x/setup/dingtalk/bind/start?token=" + encodeURIComponent(ctx.localToken));
  const denied = fakeResponse();
  await handlePairRoutes(request("POST", "", { headers: {} }), denied, url, ctx);
  assert.equal(denied.out.status, 403);

  const ok = fakeResponse();
  await handlePairRoutes(request("POST", "", { headers: { "x-mo-agent-local": "1" } }), ok, url, ctx);
  assert.equal(ok.out.status, 200);
  assert.match(ok.out.body, /"ok":true/);
});

test("/setup/dingtalk/bind/start 应用未创建时返回预生成配对码", async () => {
  const ws = workspace();
  const ctx = context(ws, {
    dingtalkSetup: {
      status: () => ({ state: "idle" }),
      startPendingBinding: () => ({ ok: true, code: "123456", expiresAt: 1 }),
    },
  });
  const url = new URL("http://x/setup/dingtalk/bind/start?token=" + encodeURIComponent(ctx.localToken));
  const res = fakeResponse();
  await handlePairRoutes(request("POST", "", { headers: { "x-mo-agent-local": "1" } }), res, url, ctx);
  assert.equal(res.out.status, 200);
  assert.match(res.out.body, /"code":"123456"/);
});
test("/agents 显示各 Agent 状态与一键配置入口", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const { handled, res } = await get("/agents", ctx);
  assert.equal(handled, true);
  assert.equal(res.out.status, 200);
  assert.match(res.out.body, /一键配置/);
  assert.match(res.out.body, /<h2>Agent<\/h2>/);
  assert.doesNotMatch(res.out.body, /需要配置的 Agent/);
  assert.doesNotMatch(res.out.body, /其它 Agent/);
  assert.match(res.out.body, /Claude Code/);
  assert.match(res.out.body, /未配置/);
  assert.match(res.out.body, /将写入的配置/);
  assert.match(res.out.body, /授权请求：手机可批准 \/ 拒绝/);
  assert.match(res.out.body, /超时 600s/);
  assert.match(res.out.body, /action='\/setup\/hooks\/apply'/);
  assert.match(res.out.body, /一键配置全部/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("/setup 只保留安装与配对，不再嵌入一键配置入口", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const { res } = await get("/setup", ctx);
  assert.match(res.out.body, /装 App/);
  assert.match(res.out.body, /配对码/);
  assert.doesNotMatch(res.out.body, /href='\/agents'/);
  assert.doesNotMatch(res.out.body, /一键配置 Agent/);
  assert.doesNotMatch(res.out.body, /钉钉/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("/setup 配对成功后自动关闭窗口", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const { res } = await get("/setup", ctx);
  assert.match(res.out.body, /配对成功，正在关闭窗口/);
  // 桌面端窗口由 host-message 关闭，网页里退化成 window.close()
  assert.match(res.out.body, /__electrobunSendToHost\(\{type:'panel-close'\}\)/);
  assert.match(res.out.body, /s\.redeemedCount>base/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("单个列表：原生 Agent 只显示状态，不给按钮和配置说明", async () => {
  const ws = workspace();
  const manager = managerFor(ws, [profile(), nativeProfile(), disabledProfile()]);
  const ctx = context(ws, { hooksManager: manager });
  const { res } = await get("/agents?agent=dsh", ctx);
  const body = res.out.body;
  assert.match(body, /Claude Code/);
  assert.match(body, /DeepSeek Harness/);
  assert.match(body, /无需配置/);
  assert.match(body, /原生接入，不需要 hook 配置/);
  assert.doesNotMatch(body, /Codex CLI/, "未启用的档案不显示");
  assert.doesNotMatch(body, /name='agentId' value='dsh'/);
  assert.equal((body.match(/将写入的配置/g) || []).length, 0, "选中原生 Agent 时不显示 hook 配置说明");
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("非本机打开 /agents：直接 403，不泄漏页面内容", async () => {
  const ws = workspace();
  const ctx = context(ws, { isLoopback: false });
  const { res } = await get("/agents", ctx);
  assert.equal(res.out.status, 403);
  assert.match(res.out.body, /仅限电脑本机/);
  assert.doesNotMatch(res.out.body, /Claude Code/);
  assert.doesNotMatch(res.out.body, /action='\/setup\/hooks\/apply'/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("回环地址没有本机令牌：设置页、一键配置、配对页都拒绝", async () => {
  const ws = workspace();
  const ctx = context(ws);
  for (const pathname of ["/setup", "/agents", "/pair", "/pair/qr.svg"]) {
    const { res } = await get(pathname, ctx, { token: false });
    assert.equal(res.out.status, 401, pathname + " 应要求鉴权");
    assert.match(res.out.body, /需要本机鉴权/);
    assert.doesNotMatch(res.out.body, /配对码/, pathname + " 不应泄漏内容");
  }
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("本机令牌可以通过 query 换 HttpOnly Cookie，并复用到子请求", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const first = await get("/agents", ctx);
  assert.equal(first.res.out.status, 200);
  const cookie = first.res.out.headers["set-cookie"] || "";
  assert.match(cookie, new RegExp("mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN)));
  assert.doesNotMatch(cookie, new RegExp(LOCAL_TOKEN), "Cookie 不应直放本机令牌");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const reused = await get("/agents", ctx, { token: false, cookie: "mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN) });
  assert.equal(reused.res.out.status, 200);
  assert.match(reused.res.out.body, /Claude Code/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("非本机即使带正确令牌也拒绝（外网访问被切断）", async () => {
  const ws = workspace();
  const ctx = context(ws, { isLoopback: false });
  const { res } = await get("/agents", ctx, {
    remoteAddress: "192.168.1.9",
    cookie: "mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN),
  });
  assert.equal(res.out.status, 403);
  assert.match(res.out.body, /仅限电脑本机/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("POST /setup/hooks/apply：一键写入并重定向回 /agents", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const page = await get("/agents", ctx);
  const csrf = csrfOf(page.res.out.body);
  assert.ok(csrf);
  const res = fakeResponse();
  const handled = await handlePairRoutes(
    request("POST", "csrf=" + csrf + "&agentId=claude-code&action=install", {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    res,
    new URL("http://x/setup/hooks/apply"),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(res.out.status, 303);
  assert.match(res.out.headers.location, /^\/agents\?/);
  assert.match(messageOf(res.out.headers.location), /已配置 Claude Code/);
  assert.ok(fs.existsSync(ws.settings));

  const after = await get("/agents", ctx);
  assert.match(after.res.out.body, /已配置/);
  assert.match(after.res.out.body, /移除/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("POST /setup/hooks/apply：next 白名单回设置中心 agents tab", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const page = await get("/agents", ctx);
  const csrf = csrfOf(page.res.out.body);
  const res = fakeResponse();
  await handlePairRoutes(
    request("POST", "csrf=" + csrf + "&agentId=claude-code&action=install&next=" + encodeURIComponent("/settings?tab=agents"), {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    res,
    new URL("http://x/setup/hooks/apply"),
    ctx,
  );
  assert.equal(res.out.status, 303);
  assert.match(res.out.headers.location, /^\/settings\?tab=agents&/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("POST /setup/hooks/apply：非法 next 回退 /agents", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const page = await get("/agents", ctx);
  const csrf = csrfOf(page.res.out.body);
  const res = fakeResponse();
  await handlePairRoutes(
    request("POST", "csrf=" + csrf + "&agentId=claude-code&action=install&next=" + encodeURIComponent("//evil.example"), {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    res,
    new URL("http://x/setup/hooks/apply"),
    ctx,
  );
  assert.equal(res.out.status, 303);
  assert.match(res.out.headers.location, /^\/agents\?/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("GET /setup/renew：next 只允许设置中心 app tab", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const allowed = await get("/setup/renew?next=" + encodeURIComponent("/settings?tab=app"), ctx);
  assert.equal(allowed.res.out.status, 302);
  assert.equal(allowed.res.out.headers.location, "/settings?tab=app");
  const denied = await get("/setup/renew?next=" + encodeURIComponent("//evil.example"), ctx);
  assert.equal(denied.res.out.status, 302);
  assert.equal(denied.res.out.headers.location, "/setup");
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("缺少表单令牌的跨站 POST 被拒绝", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const res = fakeResponse();
  await handlePairRoutes(
    request("POST", "agentId=claude-code&action=install", {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    res,
    new URL("http://x/setup/hooks/apply"),
    ctx,
  );
  assert.equal(res.out.status, 403);
  assert.match(res.out.body, /页面已过期/);
  assert.equal(fs.existsSync(ws.settings), false);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("非本机 POST 被拒绝，不碰配置文件", async () => {
  const ws = workspace();
  const ctx = context(ws, { isLoopback: false });
  const res = fakeResponse();
  const handled = await handlePairRoutes(
    request("POST", "agentId=claude-code&action=install", {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    res,
    new URL("http://x/setup/hooks/apply"),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(res.out.status, 403);
  assert.match(res.out.body, /仅限电脑本机/);
  assert.equal(fs.existsSync(ws.settings), false);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("卸载：从 /agents 移除后配置还原", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const page = await get("/agents", ctx);
  const csrf = csrfOf(page.res.out.body);
  const install = fakeResponse();
  await handlePairRoutes(request("POST", "csrf=" + csrf + "&agentId=claude-code&action=install", {
    headers: { "x-mo-agent-local": ctx.localToken },
  }), install, new URL("http://x/setup/hooks/apply"), ctx);
  assert.ok(fs.existsSync(ws.settings));

  const remove = fakeResponse();
  await handlePairRoutes(request("POST", "csrf=" + csrf + "&agentId=claude-code&action=uninstall", {
    headers: { "x-mo-agent-local": ctx.localToken },
  }), remove, new URL("http://x/setup/hooks/apply"), ctx);
  assert.equal(remove.out.status, 303);
  assert.match(messageOf(remove.out.headers.location), /已移除 Claude Code/);
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.settings, "utf8")), {});
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

function piExtensionMock() {
  let installed = false;
  const calls = [];
  return {
    calls,
    status() {
      return {
        dir: "~/.pi/agent/extensions",
        installed,
        outdated: false,
        files: [
          { name: "mo-agent-control.js", exists: installed, marker: installed, missingSource: false },
          { name: "mo-agent-control-impl.js", exists: installed, marker: installed, missingSource: false },
        ],
      };
    },
    install() {
      installed = true;
      calls.push("install");
      return { ok: true, changed: true, backups: [] };
    },
    uninstall() {
      installed = false;
      calls.push("uninstall");
      return { ok: true, changed: true };
    },
  };
}

test("/agents 显示 Pi 控制扩展安装入口", async () => {
  const ws = workspace();
  const piExtension = piExtensionMock();
  const ctx = context(ws, { piExtension });
  const page = await get("/agents?agent=pi", ctx);
  assert.equal(page.res.out.status, 200);
  assert.match(page.res.out.body, /Pi 控制扩展/);
  assert.match(page.res.out.body, /安装控制扩展/);
  assert.match(page.res.out.body, /不拦截工具/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("POST /setup/pi/apply：安装与卸载 Pi 控制扩展", async () => {
  const ws = workspace();
  const piExtension = piExtensionMock();
  const ctx = context(ws, { piExtension });
  const page = await get("/agents?agent=pi", ctx);
  const csrf = csrfOf(page.res.out.body);
  assert.ok(csrf);

  const install = fakeResponse();
  const handledInstall = await handlePairRoutes(
    request("POST", "csrf=" + csrf + "&action=install", {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    install,
    new URL("http://x/setup/pi/apply"),
    ctx
  );
  assert.equal(handledInstall, true);
  assert.equal(install.out.status, 303);
  assert.match(messageOf(install.out.headers.location), /已安装 Pi 控制扩展/);
  assert.deepEqual(piExtension.calls, ["install"]);

  const afterInstall = await get("/agents?agent=pi", ctx);
  assert.match(afterInstall.res.out.body, /卸载/);

  const nextCsrf = csrfOf(afterInstall.res.out.body);
  const uninstall = fakeResponse();
  const handledUninstall = await handlePairRoutes(
    request("POST", "csrf=" + nextCsrf + "&action=uninstall", {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    uninstall,
    new URL("http://x/setup/pi/apply"),
    ctx
  );
  assert.equal(handledUninstall, true);
  assert.equal(uninstall.out.status, 303);
  assert.match(messageOf(uninstall.out.headers.location), /已卸载 Pi 控制扩展/);
  assert.deepEqual(piExtension.calls, ["install", "uninstall"]);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("POST /setup/pi/apply：Pi 扩展管理不可用时返回 503", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const res = fakeResponse();
  const handled = await handlePairRoutes(
    request("POST", "csrf=anything&action=install", {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    res,
    new URL("http://x/setup/pi/apply"),
    ctx
  );
  assert.equal(handled, true);
  assert.equal(res.out.status, 503);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("POST /setup/pi/apply：真实写入 ~/.pi/agent/extensions", async () => {
  const ws = workspace();
  const home = path.join(ws.dir, "pi-home");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const piExtension = {
    status: () => piExtensionStatus({ root: repoRoot, home, env: {} }),
    install: () => installPiExtension({ root: repoRoot, home, env: {} }),
    uninstall: () => uninstallPiExtension({ root: repoRoot, home, env: {} }),
  };
  const ctx = context(ws, { piExtension });
  const page = await get("/agents?agent=pi", ctx);
  const csrf = csrfOf(page.res.out.body);
  const res = fakeResponse();
  await handlePairRoutes(
    request("POST", "csrf=" + csrf + "&action=install", {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    res,
    new URL("http://x/setup/pi/apply"),
    ctx
  );
  assert.equal(res.out.status, 303);
  const loader = path.join(home, ".pi", "agent", "extensions", "mo-agent-control.js");
  assert.ok(fs.existsSync(loader));
  assert.match(fs.readFileSync(loader, "utf8"), /MO_AGENT_PI_CONTROL/);

  const after = await get("/agents?agent=pi", ctx);
  assert.match(after.res.out.body, /已安装/);
  assert.match(after.res.out.body, /卸载/);

  const uninstall = fakeResponse();
  await handlePairRoutes(
    request("POST", "csrf=" + csrfOf(after.res.out.body) + "&action=uninstall", {
      headers: { "x-mo-agent-local": ctx.localToken },
    }),
    uninstall,
    new URL("http://x/setup/pi/apply"),
    ctx
  );
  assert.equal(fs.existsSync(loader), false);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("/agents 不再把 Pi 显示成不支持的 hook Agent", async () => {
  const ws = workspace();
  const piExtension = piExtensionMock();
  const piProfile = { id: "pi", label: "Pi", enabled: true, hooks: { kind: "pi-extension" } };
  const ctx = context(ws, {
    piExtension,
    hooksManager: managerFor(ws, [profile(), piProfile]),
  });
  const page = await get("/agents", ctx);
  assert.match(page.res.out.body, /Pi 控制扩展/);
  assert.doesNotMatch(page.res.out.body, /暂不支持一键配置/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});
