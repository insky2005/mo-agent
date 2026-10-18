import { spawn } from "node:child_process";

const PORT = 7805;
const BASE = "http://127.0.0.1:" + PORT;
const LOCAL = "test-local-token";
const root = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(method, path, body, headers) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(body ? { "content-type": "application/json" } : {}, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const server = spawn("node", ["host/index.mjs", "--no-auth", "--port", String(PORT), "--log-level", "warn"], {
  cwd: root,
  env: Object.assign({}, process.env, { MO_AGENT_LOCAL_TOKEN: LOCAL }),
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stderr.write("[srv] " + d));
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

let abort = null;
const events = [];
function openSse() {
  abort = new AbortController();
  fetch(BASE + "/api/events?since=0&token=x", { signal: abort.signal })
    .then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let data = "";
          for (const line of block.split("\n")) if (line.startsWith("data: ")) data += line.slice(6);
          if (data) { try { events.push(JSON.parse(data)); } catch (e) { /* ignore */ } }
        }
      }
    })
    .catch(() => {});
}
function closeSse() { if (abort) abort.abort(); abort = null; }

try {
  for (let i = 0; i < 40; i += 1) {
    try { const h = await j("GET", "/api/health"); if (h.json && h.json.ok) break; } catch (e) { /* retry */ }
    await sleep(250);
  }
  const health = await j("GET", "/api/health");
  console.log("HEALTH", JSON.stringify(health.json));

  const state = await j("GET", "/api/state");
  const agents = {};
  for (const s of (state.json.state.sessions || [])) agents[s.agent] = (agents[s.agent] || 0) + 1;
  console.log("AGENTS", JSON.stringify(agents), "processes=" + (state.json.state.processes || []).length);
  console.log("SAMPLE", JSON.stringify((state.json.state.sessions || []).slice(0, 3).map((s) => ({ agent: s.agent, status: s.status, title: String(s.title).slice(0, 40) }))));

  // 场景 A：没有手机在线 -> 必须立刻 defer（交回本地终端）
  const a = await j("POST", "/local/approval", { agent: "claude-code", toolName: "Bash", title: "rm -rf build" }, { "x-mo-agent-local": LOCAL });
  console.log("NO_CLIENT", JSON.stringify(a.json), a.json.decision === "defer" ? "PASS" : "FAIL");

  // 场景 B：手机在线 -> 挂起，等人决定
  openSse();
  await sleep(600);
  const pendingCall = j("POST", "/local/approval", { agent: "claude-code", toolName: "Bash", title: "npm publish" }, { "x-mo-agent-local": LOCAL });
  let pendingEvent = null;
  for (let i = 0; i < 40 && !pendingEvent; i += 1) {
    pendingEvent = events.find((e) => e.type === "approval.pending");
    if (!pendingEvent) await sleep(150);
  }
  if (!pendingEvent) throw new Error("没有收到 approval.pending 事件");
  console.log("PENDING_EVENT", JSON.stringify(pendingEvent.payload).slice(0, 200));

  const approved = await j("POST", "/api/approve", { id: pendingEvent.payload.id, decision: "allow_once" });
  console.log("APPROVE_CALL", JSON.stringify(approved.json));
  const resolved = await pendingCall;
  console.log("WITH_CLIENT", JSON.stringify(resolved.json), resolved.json.decision === "allow_once" ? "PASS" : "FAIL");

  // 场景 C：拒绝
  const pendingCall2 = j("POST", "/local/approval", { agent: "claude-code", toolName: "Bash", title: "drop table" }, { "x-mo-agent-local": LOCAL });
  let ev2 = null;
  for (let i = 0; i < 40 && !ev2; i += 1) {
    ev2 = events.filter((e) => e.type === "approval.pending")[1];
    if (!ev2) await sleep(150);
  }
  await j("POST", "/api/approve", { id: ev2.payload.id, decision: "reject_once" });
  const resolved2 = await pendingCall2;
  console.log("REJECT", JSON.stringify(resolved2.json), resolved2.json.decision === "reject_once" ? "PASS" : "FAIL");

  closeSse();
} catch (error) {
  console.log("TEST_ERROR", error.message);
} finally {
  server.kill("SIGTERM");
  await sleep(600);
  process.exit(0);
}
