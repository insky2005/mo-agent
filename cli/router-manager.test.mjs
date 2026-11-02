import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../core/hub.mjs";
import { SESSION_ROLE } from "../core/contract.mjs";
import { admitRuntime } from "../core/router.mjs";
import { createRouterManager, PI_ROUTER_CAPABILITIES, resolveRuntime } from "./lib/router-manager.mjs";
import * as P from "./lib/router-paths.mjs";

const silentLog = { info() {}, warn() {}, error() {} };

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-router-"));
}

function fakeRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-router-bin-"));
  const bin = path.join(dir, "pi");
  fs.writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  return bin;
}

function make(options) {
  // dataDir 跟数据走、osHome 推程序产物路径；测试里两者都落在临时目录
  return createRouterManager({
    dataDir: options.home,
    osHome: options.home,
    hub: options.hub,
    log: silentLog,
    env: options.env,
  });
}

test("空目录时 status 是未运行、未引导", () => {
  const home = tempHome();
  const hub = new Hub({ log: silentLog });
  const status = make({ home, hub, env: {} }).status();
  assert.equal(status.running, false);
  assert.equal(status.onboarded, false);
  assert.equal(status.inHub, false);
  assert.equal(status.sessionId, "mo-router");
});

test("运行时解析：env 覆盖优先，私有目录按版本号取最大", () => {
  const home = tempHome();
  const fake = fakeRuntime();
  assert.equal(resolveRuntime({ home, env: { MO_ROUTER_RUNTIME_BIN: fake } }).source, "env");

  const runtimeBase = path.join(P.runtimeRoot({ home, platform: process.platform, env: {} }), "routers", "pi");
  for (const version of ["1.2.0", "1.3.0"]) {
    const bin = path.join(runtimeBase, version, "bin", "pi");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "x", { mode: 0o755 });
  }
  const found = resolveRuntime({ home, env: {} });
  assert.equal(found.source, "private");
  assert.equal(found.version, "1.3.0");
  assert.equal(resolveRuntime({ home: tempHome(), env: {} }), null);
});

test("Pi 的声明能力能过准入", () => {
  assert.equal(admitRuntime(PI_ROUTER_CAPABILITIES).ok, true);
  assert.equal(PI_ROUTER_CAPABILITIES.toolRestriction, "allowlist");
});

test("headless 启动：写状态、注入 hub、可 attach、可停止", async () => {
  const home = tempHome();
  const hub = new Hub({ log: silentLog });
  const env = {
    MO_ROUTER_HEADLESS: "1",
    MO_ROUTER_RUNTIME_BIN: fakeRuntime(),
    DEEPSEEK_API_KEY: "sk-router-test-1234",
  };
  const manager = make({ home, hub, env });

  const started = await manager.start();
  try {
    assert.ok(started.pid > 0, "没有拿到 pid");
    assert.equal(started.attached, false);
    assert.equal(started.provider, "deepseek");

    // 状态文件：不含 key
    const stateText = fs.readFileSync(P.routerFile(home), "utf8");
    assert.ok(!stateText.includes("sk-router-test-1234"), "router.json 里不该有 key");
    const state = JSON.parse(stateText);
    assert.equal(state.onboarded, true);
    assert.equal(state.sessionId, "mo-router");
    assert.equal(state.pid, started.pid);

    // 启动脚本：私密
    const scriptStat = fs.statSync(P.startScriptFile(home));
    assert.equal(scriptStat.mode & 0o777, 0o700);

    // 契约与 README 落盘
    assert.ok(fs.readFileSync(P.contractFile(home), "utf8").includes("指挥台"));
    assert.ok(fs.readFileSync(P.workbenchReadme(home), "utf8").includes("不是项目"));

    // mo 的 MCP 只注册进私有配置目录（格式与 pi mcp add 一致，已实测）
    const mcp = JSON.parse(fs.readFileSync(P.mcpConfigFile(home), "utf8"));
    assert.equal(mcp.mcpServers.mo.command, "mo");
    assert.deepEqual(mcp.mcpServers.mo.args, ["mcp"]);

    // 控制扩展进了私有目录：手机/钉钉才能给指挥台发指令
    assert.ok(fs.existsSync(P.extensionFile(home)), "控制扩展没复制进私有配置目录");

    // hub 里的会话带 router 角色
    const session = hub.get("mo-router");
    assert.ok(session, "hub 里没有 Router 会话");
    assert.equal(session.role, SESSION_ROLE.ROUTER);
    assert.equal(session.agent, "pi");
    assert.equal(hub.list({ role: "router" }).length, 1);

    // 第二次 start 是 attach
    const again = await manager.start();
    assert.equal(again.attached, true);
    assert.equal(again.pid, started.pid);
  } finally {
    const stopped = manager.stop();
    assert.equal(stopped.stopped, true);
  }

  const after = manager.status();
  assert.equal(after.running, false);
  assert.equal(after.inHub, false);
});

test("没有凭据时拒绝启动", async () => {
  const home = tempHome();
  const hub = new Hub({ log: silentLog });
  const manager = make({ home, hub, env: { MO_ROUTER_HEADLESS: "1", MO_ROUTER_RUNTIME_BIN: fakeRuntime() } });
  await assert.rejects(() => manager.start(), (error) => error.code === "E_ROUTER_NO_CREDENTIAL");
});

test("没有运行时拒绝启动", async () => {
  const home = tempHome();
  const hub = new Hub({ log: silentLog });
  const manager = make({ home, hub, env: { DEEPSEEK_API_KEY: "sk-x" } });
  await assert.rejects(() => manager.start(), (error) => error.code === "E_ROUTER_RUNTIME_MISSING");
});
