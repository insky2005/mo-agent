import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
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


/** 假 DSH 控制面：只需要鉴权、会话列表与 session/prompt，用来验证口述真的只发一次。 */
function startFakeDsh() {
  const state = { prompts: [] };
  const server = http.createServer(function (req, res) {
    if (req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": "dsh=fake; Path=/",
      });
      res.end("ok");
      return;
    }
    let body = "";
    req.on("data", function (chunk) { body += chunk.toString(); });
    req.on("end", function () {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch (error) { payload = {}; }
      const method = payload.method || "";
      let value = {};
      if (method === "session/list") {
        value = {
          items: [{
            sessionId: "session-demo",
            cwd: "/tmp/mo-agent-demo",
            running: true,
            agentAvailable: true,
            updatedAt: Date.now(),
            projections: { values: { title: "演示会话" } },
          }],
        };
      } else if (method === "session/prompt") {
        state.prompts.push(payload.payload || {});
        value = { accepted: true };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId: payload.rpcId, result: { ok: true, value: value } }));
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", function () {
      resolve({
        port: server.address().port,
        prompts: state.prompts,
        close: function () {
          return new Promise(function (done) {
            server.close(function () { done(); });
            setTimeout(done, 500);
          });
        },
      });
    });
  });
}

function sseClient(port, token) {
  const controller = new AbortController();
  const events = [];
  let buffer = "";
  let reading = null;
  const ready = (async function () {
    const response = await fetch("http://127.0.0.1:" + port + "/local/voice-events?token=" + encodeURIComponent(token), { signal: controller.signal });
    if (response.status !== 200) throw new Error("SSE " + response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    reading = (async function () {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index !== -1) {
            const block = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 2);
            for (const line of block.split("\n")) {
              if (line.indexOf("data: ") !== 0) continue;
              try { events.push(JSON.parse(line.slice(6))); } catch (error) { /* 忽略 */ }
            }
            index = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        /* abort 后正常退出 */
      }
    })();
    return events;
  })();
  return {
    ready: ready,
    events: events,
    abort: function () {
      controller.abort();
      if (reading) reading.catch(function () {});
    },
  };
}

async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise(function (resolve) { setTimeout(resolve, 40); });
  }
  throw new Error(message || "等待条件超时");
}

test("host 集成：HTTP 授权 → broker → 脚本语音 → allow_once", { skip, timeout: 20000 }, async function () {
  const port = 17800 + Math.floor(Math.random() * 100);
  const token = "voice-e2e-" + Date.now();
  let output = "";
  const child = spawn(process.execPath, ["host/index.mjs", "--port", String(port), "--no-auth", "--log-level", "debug"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      MO_AGENT_VOICE: "1",
      MO_AGENT_NOTIFY_DISABLE: "1",
      MO_AGENT_VOICE_SCRIPT: "四七二九,四七二九",
      MO_AGENT_CLAUDE_ROOT: path.join(root, ".build", "claude-empty-e2e"),
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
    assert.ok(!output.includes("已注册通知通道"), "测试 host 不应加载通知通道");

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
    assert.ok(!output.includes("HMS 推送"), "测试不应发送 HMS 推送");
  } finally {
    await stop(child);
  }
});

test("host 集成：语音命令（暂停 → 状态 → 继续）", { skip, timeout: 30000 }, async function () {
  const port = 17900 + Math.floor(Math.random() * 100);
  const token = "voice-cmd-" + Date.now();
  let output = "";
  const child = spawn(process.execPath, ["host/index.mjs", "--port", String(port), "--no-auth", "--log-level", "debug"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      MO_AGENT_VOICE: "1",
      MO_AGENT_NOTIFY_DISABLE: "1",
      MO_AGENT_VOICE_SCRIPT: "暂停,确认,汇报状态,继续,确认",
      MO_AGENT_CLAUDE_ROOT: path.join(root, ".build", "claude-empty-e2e"),
      MO_AGENT_VOICE_DRY: "1",
      MO_AGENT_VOICE_MUTE_MINUTES: "15",
      MO_AGENT_LOCAL_TOKEN: token,
      MO_AGENT_NO_PARENT_WATCH: "1",
      // 这条用例断言「没有手机在线时立即交回终端」，关掉等待推送设备的窗口。
      MO_AGENT_APPROVAL_GRACE_MS: "0",
      MO_AGENT_DEVICE_FILE: path.join(root, ".build", "devices-e2e-cmd.json"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", function (chunk) { output += chunk.toString(); });
  child.stderr.on("data", function (chunk) { output += chunk.toString(); });

  const command = async function () {
    const response = await fetch("http://127.0.0.1:" + port + "/local/voice-command", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mo-agent-local": token },
      body: "{}",
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const notify = async function (title) {
    const response = await fetch("http://127.0.0.1:" + port + "/local/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mo-agent-local": token },
      body: JSON.stringify({ agentLabel: "Claude", noticeTitle: title, body: "x" }),
    });
    assert.equal(response.status, 200);
  };

  try {
    await waitForOutput(function () { return output; }, "语音以脚本应答启用", 10000);
    await waitForOutput(function () { return output; }, "本机:", 5000);
    assert.ok(!output.includes("已注册通知通道"), "测试 host 不应加载通知通道");

    // 浮层用的实时事件流：先连上，再发命令。
    const sseAbort = new AbortController();
    const sseEvents = [];
    let sseBuffer = "";
    const sseResponse = await fetch("http://127.0.0.1:" + port + "/local/voice-events?token=" + encodeURIComponent(token), { signal: sseAbort.signal });
    assert.equal(sseResponse.status, 200);
    const sseReader = sseResponse.body.getReader();
    const ssePump = (async function () {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await sseReader.read();
          if (chunk.done) break;
          sseBuffer += decoder.decode(chunk.value, { stream: true });
          let index = sseBuffer.indexOf("\n\n");
          while (index !== -1) {
            const block = sseBuffer.slice(0, index).trim();
            sseBuffer = sseBuffer.slice(index + 2);
            for (const line of block.split("\n")) {
              if (line.indexOf("data: ") === 0) {
                try { sseEvents.push(JSON.parse(line.slice(6))); } catch (error) { /* 忽略 */ }
              }
            }
            index = sseBuffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        /* abort 后正常退出 */
      }
    })();
    const waitForSse = async function (predicate, timeoutMs) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (predicate(sseEvents)) return;
        await new Promise(function (resolve) { setTimeout(resolve, 20); });
      }
      throw new Error("等待语音事件超时，已收到: " + JSON.stringify(sseEvents));
    };

    const paused = await command();
    assert.equal(paused.ok, true);
    assert.equal(paused.intent, "pause");
    assert.match(paused.reply, /已暂停/);
    await waitForOutput(function () { return output; }, "语音命令: 文本=「暂停」 intent=pause 结果=muted 15min", 3000);
    assert.ok(output.includes("语音命令: 收到本机请求"), "应记录请求入口");
    assert.ok(output.includes("语音命令: 开始监听"), "应记录开始监听");
    assert.ok(output.includes("语音命令: 确认输入"), "应记录确认输入");
    assert.ok(output.includes("归一=「暂停」"), "应记录归一文本");
    assert.ok(output.includes("语音命令: 请求结束"), "应记录请求结束与耗时");

    await waitForSse(function (events) { return events.some(function (event) { return event.phase === "done"; }); }, 3000);
    const phases = sseEvents.map(function (event) { return event.phase; });
    for (const phase of ["start", "listening", "heard", "parsed", "confirm", "confirm-heard", "result", "done"]) {
      assert.ok(phases.includes(phase), "缺少浮层事件 " + phase + "，实际: " + phases.join(","));
    }
    assert.ok(
      sseEvents.findIndex(function (event) { return event.phase === "result"; })
        < sseEvents.findIndex(function (event) { return event.phase === "done"; }),
      "result 事件必须先于 done"
    );
    await sseAbort.abort();

    // 静音期间 critical 通知不播报，但通知本身照常发出
    const mutedNotice = "静音期间不播报XYZ";
    await notify(mutedNotice);
    await waitForOutput(function () { return output; }, mutedNotice, 3000);
    assert.ok(!output.includes('"type":"tts-dry","text":"' + mutedNotice), "静音时不应 TTS 播报");

    // 静音期间没有手机在线：审批直接交回终端，且不进入语音询问
    const approval = await fetch("http://127.0.0.1:" + port + "/local/approval", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mo-agent-local": token },
      body: JSON.stringify({ agent: "claude", toolName: "Bash", title: "静音期间审批", toolInput: { command: "ls" } }),
    });
    const decision = await approval.json();
    assert.equal(decision.decision, "defer");
    assert.equal(decision.reason, "no-client");
    assert.ok(!output.includes("语音询问"), "静音时不应发起语音审批");

    const status = await command();
    assert.equal(status.intent, "status");
    assert.match(status.reply, /语音已静音，还剩 15 分钟/);

    const resumed = await command();
    assert.equal(resumed.ok, true);
    assert.equal(resumed.intent, "resume");
    assert.match(resumed.reply, /已恢复/);

    const resumedNotice = "恢复后播报XYZ";
    await notify(resumedNotice);
    await waitForOutput(function () {
      return output;
    }, '"type":"tts-dry","text":"' + resumedNotice, 3000);
    assert.ok(!output.includes("HMS 推送"), "测试不应发送 HMS 推送");
  } finally {
    try { sseAbort.abort(); } catch (error) { /* 忽略 */ }
    await stop(child);
  }
});
test("host 集成：语音口述 → 草稿 → 确认发送只发一次；取消/超时不发", { skip, timeout: 60000 }, async function () {
  const fake = await startFakeDsh();
  const port = 18100 + Math.floor(Math.random() * 100);
  const token = "voice-dictate-" + Date.now();
  const dshHome = path.join(root, ".build", "dsh-home-dictate-" + Date.now());
  fs.mkdirSync(path.join(dshHome, "oh-my-dsh", "shell"), { recursive: true });
  fs.writeFileSync(
    path.join(dshHome, "oh-my-dsh", "shell", "dsh-web.json"),
    JSON.stringify({ port: fake.port, token: "fake-token" })
  );

  let output = "";
  const child = spawn(process.execPath, ["host/index.mjs", "--port", String(port), "--no-auth", "--log-level", "debug"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      MO_AGENT_VOICE: "1",
      MO_AGENT_NOTIFY_DISABLE: "1",
      MO_AGENT_VOICE_SCRIPT: "把登录页改成深色,确认发送,第二段内容,取消",
      MO_AGENT_CLAUDE_ROOT: path.join(root, ".build", "claude-empty-e2e"),
      MO_AGENT_VOICE_DRY: "1",
      MO_AGENT_LOCAL_TOKEN: token,
      MO_AGENT_NO_PARENT_WATCH: "1",
      MO_AGENT_POLL: "150",
      MO_AGENT_DEVICE_FILE: path.join(root, ".build", "devices-e2e-dictate.json"),
      DSH_HOME: dshHome,
      // 必须覆盖继承来的真实 DSH 地址，否则会拿假 token 去连真 DSH。
      DSH_WEB_URL: "http://127.0.0.1:" + fake.port,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", function (chunk) { output += chunk.toString(); });
  child.stderr.on("data", function (chunk) { output += chunk.toString(); });

  let sse = null;
  const dictate = async function () {
    const response = await fetch("http://127.0.0.1:" + port + "/local/dictate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mo-agent-local": token },
      body: "{}",
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  try {
    await waitForOutput(function () { return output; }, "语音以脚本应答启用", 10000);
    await waitForOutput(function () { return output; }, "本机:", 5000);
    await waitFor(async function () {
      const state = await fetch("http://127.0.0.1:" + port + "/api/state");
      const body = await state.json();
      return !!body.state && body.state.sessions.some(function (item) { return item.id === "session-demo"; });
    }, 10000, "假 DSH 会话没有进入 hub");
    sse = sseClient(port, token);
    await sse.ready;

    const sent = await dictate();
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.intent, "dictate");
    assert.equal(sent.action, "sent");
    assert.equal(sent.target.title, "演示会话");
    assert.equal(sent.draft.text, "把登录页改成深色");
    assert.equal(fake.prompts.length, 1, "确认发送只能调用一次 session/prompt");
    assert.equal(fake.prompts[0].args.request.content[0].text, "把登录页改成深色");
    assert.equal(fake.prompts[0].args.request.sessionId, "session-demo");

    await waitForOutput(function () { return output; }, "语音口述: 收到本机请求", 3000);
    await waitForOutput(function () { return output; }, "语音口述: 草稿 目标=演示会话", 3000);
    await waitForOutput(function () { return output; }, "语音口述: 已发送 目标=演示会话(session-demo)", 3000);
    await waitForOutput(function () { return output; }, "语音口述: 请求结束", 3000);
    assert.ok(output.includes("语音口述: 确认输入 文本=「确认发送」 判定=confirm"), "应记录严格确认判定");

    await waitFor(function () {
      return sse.events.some(function (event) { return event.phase === "done"; });
    }, 5000, "浮层没收到 done 事件");
    const phases = sse.events.map(function (event) { return event.phase; });
    for (const phase of ["start", "target", "draft", "confirm", "confirm-heard", "sending", "result", "done"]) {
      assert.ok(phases.includes(phase), "缺少浮层事件 " + phase + "，实际: " + phases.join(","));
    }
    const resultEvent = sse.events.find(function (event) { return event.phase === "result"; });
    assert.equal(resultEvent.action, "sent");
    assert.equal(resultEvent.target.title, "演示会话");
    assert.ok(
      sse.events.findIndex(function (event) { return event.phase === "draft"; })
        < sse.events.findIndex(function (event) { return event.phase === "confirm"; }),
      "draft 事件必须先于 confirm"
    );

    // 取消：不发送
    const cancelled = await dictate();
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.action, "cancel");
    assert.equal(fake.prompts.length, 1, "取消后不应发送");

    // 脚本用完 → 录音超时：不发送
    const timedOut = await dictate();
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.action, "timeout");
    assert.equal(fake.prompts.length, 1, "超时后不应发送");
    await waitForOutput(function () { return output; }, "语音口述: 未发送 原因=timeout", 3000);

    assert.ok(!output.includes("HMS 推送"), "测试不应发送 HMS 推送");
  } finally {
    if (sse) sse.abort();
    await stop(child);
    await fake.close();
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});
