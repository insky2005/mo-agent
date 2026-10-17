#!/usr/bin/env node
/**
 * Agent hook 调用的入口。
 *
 * 用法（Claude Code）：
 *   node approvals/hook-cli.mjs permission   # 用于 PermissionRequest，会阻塞等人
 *   node approvals/hook-cli.mjs notify       # 用于 Notification，只上报不阻塞
 *
 * 关键行为：拿不到决定时「不输出任何内容并 exit 0」，
 * 让 Agent 回到它自己的本地提示，绝不代替用户放行。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODE = process.argv[2] || "permission";
const SESSION_FILE = path.join(os.homedir(), ".mo-agent", "session.json");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

function loadSession() {
  const envUrl = process.env.MO_AGENT_URL;
  const envToken = process.env.MO_AGENT_TOKEN;
  if (envUrl && envToken) return { url: envUrl, token: envToken };
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    if (raw && raw.url && raw.token) return raw;
  } catch (error) {
    /* mo-agent没在跑 */
  }
  return null;
}

async function post(session, pathname, body) {
  const res = await fetch(session.url + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mo-agent-local": session.token },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch (error) {
    input = {};
  }

  const session = loadSession();
  if (!session) process.exit(0);

  const payload = {
    agent: "claude-code",
    agentLabel: process.env.MO_AGENT_AGENT_LABEL || "Claude Code",
    sessionId: firstString(input, ["session_id", "sessionId"]),
    toolName: firstString(input, ["tool_name", "toolName"]),
    toolInput: input.tool_input || input.toolInput || null,
    title: firstString(input, ["tool_name", "toolName"]) || "需要授权",
    cwd: firstString(input, ["cwd"]),
    permissionMode: firstString(input, ["permission_mode", "permissionMode"]),
  };

  if (MODE === "notify") {
    try {
      await post(session, "/local/notify", payload);
    } catch (error) {
      /* 上报失败不影响 Agent */
    }
    process.exit(0);
  }

  let decision = "defer";
  try {
    const result = await post(session, "/local/approval", payload);
    if (result && typeof result.decision === "string") decision = result.decision;
  } catch (error) {
    decision = "defer";
  }

  if (decision === "defer") process.exit(0);

  const behavior = decision.indexOf("allow") === 0 ? "allow" : "deny";
  const out = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "用户在手机上拒绝了该操作" },
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main().catch(() => process.exit(0));
