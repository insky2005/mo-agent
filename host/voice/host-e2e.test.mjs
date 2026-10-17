import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const skip = process.env.MO_AGENT_SKIP_HOST_E2E === "1";

function waitForOutput(getOutput, needle, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const started = Date.now();
    const timer = setInterval(function () {
      const output = getOutput();
      if (output.includes(needle)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("等待「" + needle + "」超时。输出：\n" + output.slice(-2000)));
      }
    }, 50);
  });
}

function stop(child) {
  return new Promise(function (resolve) {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", function () { resolve(); });
    child.kill("SIGTERM");
    setTimeout(function () {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000);
    setTimeout(resolve, 3000);
  });
}

test("host 集成：HTTP 授权 → broker → 脚本语音 → allow_once", { skip, timeout: 20000 }, async function () {
  const port = 17800 + Math.floor(Math.random() * 100);
  const token = "voice-e2e-" + Date.now();
  let output = "";
  const child = spawn(process.execPath, ["host/index.mjs", "--port", String(port), "--no-auth", "--log-level", "debug"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      MO_AGENT_VOICE: "1",
      MO_AGENT_VOICE_SCRIPT: "四七二九,四七二九",
      MO_AGENT_VOICE_NONCE: "4729",
      MO_AGENT_VOICE_DRY: "1",
      MO_AGENT_LOCAL_TOKEN: token,
      MO_AGENT_NO_PARENT_WATCH: "1",
      MO_AGENT_DEVICE_FILE: path.join(root, ".build", "devices-e2e.json"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", function (chunk) { output += chunk.toString(); });
  child.stderr.on("data", function (chunk) { output += chunk.toString(); });

  try {
    await waitForOutput(function () { return output; }, "语音以脚本应答启用", 10000);
    await waitForOutput(function () { return output; }, "本机:", 5000);

    const response = await fetch("http://127.0.0.1:" + port + "/local/approval", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mo-agent-local": token,
      },
      body: JSON.stringify({
        agent: "claude",
        agentLabel: "Claude Code",
        toolName: "Bash",
        title: "执行命令",
        toolInput: { command: "rm -rf build" },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.decision, "allow_once");
    assert.equal(result.reason, "user");
    assert.ok(output.includes("语音询问"), "应打印语音询问日志");
    assert.ok(output.includes("语音结果: allow"), "语音结果应为 allow");
    assert.ok(output.includes("4 7 2 9"), "TTS 草稿应念出口令");

    const notify = await fetch("http://127.0.0.1:" + port + "/local/notify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mo-agent-local": token,
      },
      body: JSON.stringify({
        agentLabel: "Claude",
        noticeTitle: "Claude 需要你注意",
        body: "请选择分支",
      }),
    });
    assert.equal(notify.status, 200);
    await waitForOutput(function () { return output; }, "请选择分支", 3000);
    assert.ok(output.includes("tts-dry"), "critical 通知应走 TTS 播报");

    const testResponse = await fetch("http://127.0.0.1:" + port + "/local/voice-test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mo-agent-local": token,
      },
      body: "{}",
    });
    assert.equal(testResponse.status, 200);
    const testResult = await testResponse.json();
    assert.equal(testResult.ok, true);
    assert.equal(testResult.outcome, "allow");
    assert.ok(output.includes("语音测试"), "应打印语音测试日志");
  } finally {
    await stop(child);
  }
});
