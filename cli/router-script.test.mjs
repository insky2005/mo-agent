import test from "node:test";
import assert from "node:assert/strict";
import { renderRouterScript, renderRouterSecrets, shellQuote } from "./lib/router-script.mjs";

test("shellQuote：安全字符原样，其余单引号包裹", () => {
  assert.equal(shellQuote("plain"), "plain");
  assert.equal(shellQuote("/Users/x/.mo-agent/router"), "/Users/x/.mo-agent/router");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("启动脚本：写 pid、source 密钥文件、cd、exec，且**不含任何密钥**", () => {
  const script = renderRouterScript({
    bin: "/opt/pi",
    args: ["--session-id", "mo-router", "--tools", "read,mcp__mo__*"],
    cwd: "/Users/x/.mo-agent/router/workbench",
    secretsFile: "/Users/x/.mo-agent/router/secrets.sh",
    pidFile: "/Users/x/.mo-agent/router/router.pid",
    logFile: "/Users/x/.mo-agent/router/router.log",
  });

  const lines = script.split("\n");
  assert.equal(lines[0], "#!/bin/sh");
  assert.ok(script.includes("echo $$ > /Users/x/.mo-agent/router/router.pid"));
  assert.ok(script.includes(". /Users/x/.mo-agent/router/secrets.sh || exit 1"));
  assert.ok(script.includes("cd /Users/x/.mo-agent/router/workbench"));
  assert.ok(script.includes("exec /opt/pi --session-id mo-router --tools "));
  assert.ok(script.includes(">> /Users/x/.mo-agent/router/router.log 2>&1"));
  assert.ok(script.endsWith("\n"));
  // 关键：启动脚本里不能出现密钥
  assert.ok(!script.includes("DEEPSEEK"));
  assert.ok(!script.includes("sk-"));
});

test("密钥文件：只放 export，且内容来自传入的 env", () => {
  const secrets = renderRouterSecrets({
    env: { PI_CODING_AGENT_DIR: "/x/config", DEEPSEEK_API_KEY: "sk-secret" },
  });
  assert.ok(secrets.includes("export PI_CODING_AGENT_DIR=/x/config"));
  assert.ok(secrets.includes("export DEEPSEEK_API_KEY=sk-secret"));
  assert.ok(!secrets.includes("exec"));
  assert.ok(secrets.endsWith("\n"));
});

test("没有 logFile 时不重定向，输出留在终端里", () => {
  const script = renderRouterScript({ bin: "/opt/pi", args: [], pidFile: "/tmp/p", logFile: null });
  assert.ok(!script.includes(">>"));
  assert.ok(script.includes("exec /opt/pi"));
});

test("缺关键输入时拒绝渲染", () => {
  assert.throws(() => renderRouterScript({ pidFile: "/tmp/p" }), /可执行文件/);
  assert.throws(() => renderRouterScript({ bin: "/opt/pi" }), /pid 文件/);
});
