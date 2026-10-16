import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 读 host 写下的本机会话凭证，发一条测试通知（会走所有已配置的通知通道）
const file = process.env.MO_AGENT_SESSION || path.join(os.homedir(), ".mo-agent", "session.json");
const { url, token } = JSON.parse(fs.readFileSync(file, "utf8"));

const res = await fetch(url + "/local/notify", {
  method: "POST",
  headers: { "content-type": "application/json", "x-mo-agent-local": token },
  body: JSON.stringify({
    agentLabel: "mo-agent",
    title: "测试通知",
    body: "收到这条说明通道已通 " + new Date().toLocaleTimeString("zh-CN"),
  }),
});
console.log("发送结果:", await res.text());
console.log("通道配置: ~/.mo-agent/notify.json（示例见 docs/notify.example.json）");
