import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMoAgentServer } from "./http.mjs";
import { attachProject } from "../cli/lib/project.mjs";
import { loadCard, saveCard } from "../cli/lib/store.mjs";
import { requestConfirmation } from "../cli/lib/approvals.mjs";
import { listTaskApprovals } from "./task-approvals.mjs";

const webDir = fileURLToPath(new URL("../app/web", import.meta.url));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-taskappr-http-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.MO_AGENT_HOME = home;
  const attached = attachProject(project, { home });
  saveCard(
    project,
    { id: "t_1", project: attached.meta.id, title: "加筛选", status: "draft", created: "2026-01-01T00:00:00.000Z", verify: [{ run: "true" }] },
    "## 交付物\n\n- x\n",
  );
  const card = loadCard(project, "t_1");
  const request = requestConfirmation({ home, root: project, card }).request;
  return { root, project, home, request };
}

const noop = () => {};

function startServer() {
  const app = createMoAgentServer({
    config: { authRequired: false, pin: "123456" },
    hub: { snapshot: () => ({}), get: () => null },
    broker: { list: () => [], decide: () => false },
    log: { info: noop, warn: noop, error: noop },
    webDir,
    localToken: "local-test",
  });
  return new Promise((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve(app));
  });
}

test("GET /api/task-approvals 列出待批任务", async () => {
  const ws = workspace();
  const app = await startServer();
  try {
    const base = "http://127.0.0.1:" + app.server.address().port;
    const response = await fetch(base + "/api/task-approvals");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.pending.length, 1);
    assert.equal(body.pending[0].id, ws.request.id);
    assert.equal(body.pending[0].taskId, "t_1");
  } finally {
    app.server.close();
  }
});

test("POST /api/task-approvals/<id> 批准后卡片变 confirmed", async () => {
  const ws = workspace();
  const app = await startServer();
  try {
    const base = "http://127.0.0.1:" + app.server.address().port;
    const response = await fetch(base + "/api/task-approvals/" + ws.request.id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "approved");
    assert.equal(loadCard(ws.project, "t_1").meta.status, "confirmed");
    assert.deepEqual(listTaskApprovals({ home: ws.home }), []);
  } finally {
    app.server.close();
  }
});

test("重复处理返回 404，非法 decision 返回 400", async () => {
  const ws = workspace();
  const app = await startServer();
  try {
    const base = "http://127.0.0.1:" + app.server.address().port;
    const bad = await fetch(base + "/api/task-approvals/" + ws.request.id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(base + "/api/task-approvals/" + ws.request.id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(ok.status, 200);

    const again = await fetch(base + "/api/task-approvals/" + ws.request.id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(again.status, 404);
  } finally {
    app.server.close();
  }
});
