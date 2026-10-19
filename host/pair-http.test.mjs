import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { handlePairRoutes } from "./pair-http.mjs";
import { createHooksManager } from "./agent-hooks.mjs";

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
    isLoopback: true,
  }, overrides || {});
}

function fakeResponse() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers || {};
    },
    end(body) {
      if (body !== undefined) out.body += String(body);
    },
  };
}

function request(method, body) {
  if (body === undefined) return { method, socket: { remoteAddress: "127.0.0.1" } };
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function csrfOf(html) {
  const hit = String(html).match(/name='csrf' value='([a-f0-9]+)'/);
  return hit ? hit[1] : "";
}

function messageOf(location) {
  return new URLSearchParams(String(location).split("?")[1] || "").get("msg") || "";
}

async function get(pathname, ctx) {
  const res = fakeResponse();
  const handled = await handlePairRoutes(request("GET"), res, new URL("http://x" + pathname), ctx);
  return { handled, res };
}

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
  const { res } = await get("/agents", ctx);
  const body = res.out.body;
  assert.match(body, /Claude Code/);
  assert.match(body, /DeepSeek Harness/);
  assert.match(body, /无需配置/);
  assert.match(body, /原生接入，不需要 hook 配置/);
  assert.doesNotMatch(body, /Codex CLI/, "未启用的档案不显示");
  assert.doesNotMatch(body, /name='agentId' value='dsh'/);
  assert.equal((body.match(/将写入的配置/g) || []).length, 1, "只有 Claude 有配置说明");
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("非本机打开 /agents：只读，不渲染写入表单", async () => {
  const ws = workspace();
  const ctx = context(ws, { isLoopback: false });
  const { res } = await get("/agents", ctx);
  assert.match(res.out.body, /只能在电脑本机操作/);
  assert.doesNotMatch(res.out.body, /action='\/setup\/hooks\/apply'/);
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
    request("POST", "csrf=" + csrf + "&agentId=claude-code&action=install"),
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

test("缺少表单令牌的跨站 POST 被拒绝", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const res = fakeResponse();
  await handlePairRoutes(
    request("POST", "agentId=claude-code&action=install"),
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
    request("POST", "agentId=claude-code&action=install"),
    res,
    new URL("http://x/setup/hooks/apply"),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(res.out.status, 403);
  assert.equal(fs.existsSync(ws.settings), false);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("卸载：从 /agents 移除后配置还原", async () => {
  const ws = workspace();
  const ctx = context(ws);
  const page = await get("/agents", ctx);
  const csrf = csrfOf(page.res.out.body);
  const install = fakeResponse();
  await handlePairRoutes(request("POST", "csrf=" + csrf + "&agentId=claude-code&action=install"), install, new URL("http://x/setup/hooks/apply"), ctx);
  assert.ok(fs.existsSync(ws.settings));

  const remove = fakeResponse();
  await handlePairRoutes(request("POST", "csrf=" + csrf + "&agentId=claude-code&action=uninstall"), remove, new URL("http://x/setup/hooks/apply"), ctx);
  assert.equal(remove.out.status, 303);
  assert.match(messageOf(remove.out.headers.location), /已移除 Claude Code/);
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.settings, "utf8")), {});
  fs.rmSync(ws.dir, { recursive: true, force: true });
});
