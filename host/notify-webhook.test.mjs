import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  barkRequest,
  dingtalkRequest,
  wecomRequest,
  feishuRequest,
  genericRequest,
  createWebhookChannel,
  loadWebhookChannels,
  loadNotifyChannels,
} from "./notify-webhook.mjs";

const critical = { severity: "critical", kind: "approval", title: "需要授权", body: "运行 rm -rf" };
const normal = { severity: "normal", kind: "completed", title: "任务完成", body: "" };

test("bark 路径形式：标题/内容进路径，critical 用 alarm", () => {
  const req = barkRequest(critical, { url: "https://api.day.app/KEY" });
  assert.equal(req.method, "GET");
  assert.ok(req.url.startsWith("https://api.day.app/KEY/" + encodeURIComponent("需要授权") + "/"));
  assert.match(req.url, /level=critical/);
  assert.match(req.url, /sound=alarm/);
  assert.match(req.url, /group=mo-agent/);
});

test("bark 完成类默认静默（passive）", () => {
  const req = barkRequest(normal, { url: "https://api.day.app/KEY" });
  assert.match(req.url, /level=passive/);
  assert.doesNotMatch(req.url, /sound=alarm/);
});

test("bark deviceKey 走 POST /push", () => {
  const req = barkRequest(critical, { deviceKey: "abc123" });
  assert.equal(req.url, "https://api.day.app/push");
  assert.equal(req.method, "POST");
  const body = JSON.parse(req.body);
  assert.equal(body.device_key, "abc123");
  assert.equal(body.title, "需要授权");
});

test("钉钉：带 secret 时 URL 追加 timestamp 与 sign", () => {
  const secret = "SECtest";
  const req = dingtalkRequest(critical, { url: "https://oapi.dingtalk.com/robot/send?access_token=t", secret });
  const url = new URL(req.url);
  const timestamp = url.searchParams.get("timestamp");
  const sign = url.searchParams.get("sign");
  assert.ok(timestamp);
  const expected = createHmac("sha256", secret).update(timestamp + "\n" + secret).digest("base64");
  assert.equal(sign, expected);
  assert.equal(JSON.parse(req.body).msgtype, "markdown");
});

test("企业微信 / 飞书 / 通用：各自的消息体", () => {
  const w = JSON.parse(wecomRequest(critical, { url: "https://qyapi.weixin.qq.com/x" }).body);
  assert.equal(w.msgtype, "markdown");
  assert.match(w.markdown.content, /需要授权/);

  const f = JSON.parse(feishuRequest(critical, { url: "https://open.feishu.cn/x" }).body);
  assert.equal(f.msg_type, "text");
  assert.match(f.content.text, /需要授权/);

  const g = JSON.parse(genericRequest(critical, { url: "https://example.com/hook" }).body);
  assert.equal(g.severity, "critical");
  assert.equal(g.title, "需要授权");
});

test("createWebhookChannel 用注入的 fetch 发出请求", async () => {
  const calls = [];
  const channel = createWebhookChannel(
    { type: "generic", url: "https://example.com/hook" },
    { fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; } }
  );
  await channel.send(critical);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com/hook");
  assert.equal(calls[0].init.method, "POST");
});

test("createWebhookChannel 在非 2xx 时抛错", async () => {
  const channel = createWebhookChannel(
    { type: "generic", url: "https://example.com/hook" },
    { fetchImpl: async () => ({ ok: false, status: 500 }) }
  );
  await assert.rejects(() => channel.send(critical), /HTTP 500/);
});

test("loadWebhookChannels 读配置文件与环境变量，过滤掉没有 url 的项", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-webhook-"));
  const file = path.join(dir, "notify.json");
  fs.writeFileSync(file, JSON.stringify({ channels: [
    { type: "bark", url: "https://api.day.app/KEY" },
    { type: "generic" },
  ] }));
  const env = { MO_AGENT_NOTIFY_WEBHOOKS: JSON.stringify([{ type: "wecom", url: "https://qyapi.weixin.qq.com/x" }]) };
  const channels = loadWebhookChannels({ file, env, log: { warn() {} } });
  assert.deepEqual(channels.map((c) => c.name), ["webhook:bark", "webhook:wecom"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadNotifyChannels 会把 push token 交给 HMS 通道", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-hms-"));
  const file = path.join(dir, "notify.json");
  fs.writeFileSync(file, JSON.stringify({ channels: [{ type: "hms", appId: "1", appSecret: "x" }] }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = url.includes("oauth") ? { access_token: "AT", expires_in: 3600 } : { code: "80000000" };
    return { ok: true, status: 200, json: async () => body };
  };
  const channels = loadNotifyChannels({ file, env: {}, log: { warn() {}, info() {} }, getPushTokens: () => ["tok"], fetchImpl });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, "hms");
  await channels[0].send({ title: "t", body: "b" });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /messages:send/);
  assert.deepEqual(JSON.parse(calls[1].init.body).message.token, ["tok"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadWebhookChannels 遇到坏 JSON 只记警告", () => {
  const warned = [];
  const channels = loadWebhookChannels({ file: "/nonexistent/notify.json", env: { MO_AGENT_NOTIFY_WEBHOOKS: "{bad" }, log: { warn: (m) => warned.push(m) } });
  assert.equal(channels.length, 0);
  assert.equal(warned.length, 1);
});

test("MO_AGENT_NOTIFY_DISABLE=1 时不加载任何通知通道（测试隔离）", () => {
  assert.deepEqual(loadNotifyChannels({ env: { MO_AGENT_NOTIFY_DISABLE: "1" } }), []);
  assert.deepEqual(loadWebhookChannels({ env: { MO_AGENT_NOTIFY_DISABLE: "1" } }), []);
});
