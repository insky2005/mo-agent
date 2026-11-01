import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleSettingsRoutes } from "./settings-page.mjs";
import { adminCookieValue } from "./admin-auth.mjs";

const LOCAL_TOKEN = "test-settings-token";
const LOG_FILE = "/tmp/mo-agent-test/host.log";

function context(overrides) {
  return Object.assign({
    pairing: {
      issue: () => ({ token: "pair-token" }),
      peek: () => ({ token: "pair-token" }),
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
    hooksManager: {
      status: () => [{
        id: "claude-code",
        label: "Claude Code",
        enabled: true,
        supported: true,
        installed: false,
        outdated: false,
        settingsPath: "/tmp/settings.json",
        exists: true,
        events: [{ event: "PermissionRequest", label: "授权请求", timeout: 600, installed: false, command: "hook" }],
      }],
    },
    localToken: LOCAL_TOKEN,
    logFile: LOG_FILE,
    isLoopback: true,
  }, overrides || {});
}

function fakeResponse() {
  const out = { status: 0, headers: {}, body: "" };
  const implicit = {};
  return {
    out,
    setHeader(name, value) { implicit[String(name).toLowerCase()] = String(value); },
    writeHead(status, headers) { out.status = status; out.headers = Object.assign({}, implicit, headers || {}); },
    end(body) { if (body !== undefined) out.body += String(body); },
  };
}

function request(options = {}) {
  const req = Readable.from([Buffer.from("")]);
  req.method = options.method || "GET";
  req.headers = Object.assign({}, options.headers || {});
  if (options.cookie) req.headers.cookie = options.cookie;
  req.socket = { remoteAddress: options.remoteAddress || "127.0.0.1" };
  return req;
}

async function get(pathname, ctx, options = {}) {
  const url = new URL("http://x" + pathname);
  if (options.token !== false) url.searchParams.set("token", options.token || ctx.localToken);
  const res = fakeResponse();
  const handled = await handleSettingsRoutes(request({ cookie: options.cookie }), res, url, ctx);
  return { handled, res };
}

function scriptsOf(body) {
  return [...String(body).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((hit) => hit[1]);
}

test("GET /settings 渲染五个菜单和 App 安装与配对", async () => {
  const ctx = context();
  const { handled, res } = await get("/settings", ctx);
  assert.equal(handled, true);
  assert.equal(res.out.status, 200);
  for (const label of ["App 安装与配对", "钉钉机器人", "Agent 配置", "语音", "重启与日志"]) {
    assert.match(res.out.body, new RegExp(label));
  }
  assert.match(res.out.body, /装 App/);
  assert.match(res.out.body, /配对码/);
  assert.match(res.out.body, /aria-current='page'>App 安装与配对/);
  assert.match(res.out.body, /配对成功，正在刷新/);
  assert.doesNotMatch(res.out.body, new RegExp(LOCAL_TOKEN), "不应把本机令牌写进页面");
  assert.equal(res.out.headers["cache-control"], "no-store");
  assert.equal(res.out.headers["x-frame-options"], "DENY");
  for (const script of scriptsOf(res.out.body)) assert.doesNotThrow(() => new Function(script));
});

test("设置页没有令牌返回 401，非回环返回 403", async () => {
  const ctx = context();
  const noToken = await get("/settings", ctx, { token: false });
  assert.equal(noToken.res.out.status, 401);
  assert.match(noToken.res.out.body, /需要本机鉴权/);
  assert.doesNotMatch(noToken.res.out.body, /装 App/);

  const lan = await get("/settings", context({ isLoopback: false }));
  assert.equal(lan.res.out.status, 403);
  assert.match(lan.res.out.body, /仅限电脑本机|不允许从局域网/);
});

test("Cookie 可以复用打开设置页", async () => {
  const ctx = context();
  const first = await get("/settings", ctx);
  const cookie = first.res.out.headers["set-cookie"] || "";
  assert.match(cookie, new RegExp("mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN)));
  const reused = await get("/settings?tab=agents", ctx, {
    token: false,
    cookie: "mo_agent_admin=" + adminCookieValue(LOCAL_TOKEN),
  });
  assert.equal(reused.res.out.status, 200);
  assert.match(reused.res.out.body, /Claude Code/);
});

test("/settings?tab=agents 带 next 回跳字段", async () => {
  const { res } = await get("/settings?tab=agents", context());
  assert.equal(res.out.status, 200);
  assert.match(res.out.body, /name='next' value='\/settings\?tab=agents[^']*'/);
  assert.match(res.out.body, /一键配置/);
  assert.match(res.out.body, /切换设置分类|设置分类/);
});

test("/settings?tab=voice 展示语音开关、浮层和操作", async () => {
  const { res } = await get("/settings?tab=voice", context());
  assert.equal(res.out.status, 200);
  for (const label of ["启用语音", "语音浮层", "语音命令", "语音口述", "语音测试", "麦克风权限设置", "辅助功能权限设置"]) {
    assert.match(res.out.body, new RegExp(label));
  }
  assert.match(res.out.body, /__electrobunSendToHost/);
  assert.match(res.out.body, /settings-request/);
});

test("/settings?tab=system 同时包含重启和日志查看器", async () => {
  const { res } = await get("/settings?tab=system", context());
  assert.equal(res.out.status, 200);
  assert.match(res.out.body, /重启本地服务/);
  assert.match(res.out.body, /再次点击确认重启/);
  assert.match(res.out.body, /\/logs\/data\?lines=400/);
  assert.match(res.out.body, new RegExp(LOG_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const script of scriptsOf(res.out.body)) assert.doesNotThrow(() => new Function(script));
});

test("非法 tab 回退到 app", async () => {
  const { res } = await get("/settings?tab=bogus", context());
  assert.equal(res.out.status, 200);
  assert.match(res.out.body, /装 App/);
  assert.match(res.out.body, /aria-current='page'>App 安装与配对/);
});

test("非 /settings 路径不消费", async () => {
  const { handled } = await get("/monitor", context());
  assert.equal(handled, false);
});
