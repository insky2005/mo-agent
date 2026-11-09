import test from "node:test";
import assert from "node:assert/strict";
import { buildPiArgv } from "./lib/router-argv.mjs";
import { ROUTER_TOOL_SPEC } from "../core/router.mjs";

const BASE = {
  runtimeBin: "/Users/x/Library/Application Support/mo-agent/routers/pi/1.3.0/bin/pi",
  cwd: "/Users/x/.mo-agent/router/workbench",
  contractPath: "/Users/x/.mo-agent/router/workbench/ROUTER.md",
  agentDir: "/Users/x/.mo-agent/router/config",
};

test("启动参数把工具面收窄在命令行上，不靠提示词", () => {
  const { command, args } = buildPiArgv(BASE);
  assert.equal(command, BASE.runtimeBin);
  const at = args.indexOf("--tools");
  assert.ok(at >= 0, "缺少 --tools");
  assert.equal(args[at + 1], ROUTER_TOOL_SPEC);

  const joined = args.join(" ");
  for (const forbidden of ["bash", "edit", "write", "powershell"]) {
    assert.ok(!joined.includes(forbidden), "工具面里出现了禁用工具: " + forbidden);
  }
});

test("Router 不加载技能：--no-skills 必须在，避免读到通用主 Agent 技能", () => {
  const { args } = buildPiArgv(BASE);
  assert.ok(args.includes("--no-skills"), "缺少 --no-skills：Router 会捡到 ~/.agents/skills 里的通用技能");
});

test("会话身份固定：--session-id 与 --name", () => {
  const { args } = buildPiArgv(BASE);
  assert.equal(args[args.indexOf("--session-id") + 1], "mo-router");
  assert.equal(args[args.indexOf("--name") + 1], "指挥台");
});

test("契约通过 --append-system-prompt 注入，扩展通过 -e 注入", () => {
  const { args } = buildPiArgv({ ...BASE, extensionPath: "/Users/x/.mo-agent/router/config/extensions/mo-agent-control.js" });
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], BASE.contractPath);
  assert.equal(args[args.indexOf("-e") + 1], "/Users/x/.mo-agent/router/config/extensions/mo-agent-control.js");
  // 没给扩展时不出 -e（避免指向不存在的文件）
  assert.equal(buildPiArgv(BASE).args.includes("-e"), false);
});

test("环境变量指向私有配置目录，不碰用户全局", () => {
  const { env, cwd } = buildPiArgv({ ...BASE, sessionDir: "/Users/x/.mo-agent/router/sessions", offline: true });
  assert.equal(env.PI_CODING_AGENT_DIR, BASE.agentDir);
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, "/Users/x/.mo-agent/router/sessions");
  assert.equal(env.PI_OFFLINE, "1");
  assert.equal(cwd, BASE.cwd);
  assert.equal(buildPiArgv(BASE).env.PI_OFFLINE, undefined);
});

test("缺关键输入直接报错，不生成半套参数", () => {
  for (const [patch, code] of [
    [{ runtimeBin: "" }, "E_ROUTER_RUNTIME_MISSING"],
    [{ cwd: "" }, "E_ROUTER_START_FAILED"],
    [{ contractPath: "" }, "E_ROUTER_START_FAILED"],
    [{ agentDir: "" }, "E_ROUTER_START_FAILED"],
  ]) {
    assert.throws(() => buildPiArgv({ ...BASE, ...patch }), (error) => error.code === code, JSON.stringify(patch));
  }
});

test("工具面被改坏时拒绝启动", () => {
  assert.throws(
    () => buildPiArgv({ ...BASE, toolSpec: "read,bash" }),
    (error) => error.code === "E_ROUTER_RUNTIME_UNSUPPORTED"
  );
  assert.throws(
    () => buildPiArgv({ ...BASE, toolSpec: "*" }),
    (error) => error.code === "E_ROUTER_RUNTIME_UNSUPPORTED"
  );
});
