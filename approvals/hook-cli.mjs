#!/usr/bin/env node
/**
 * Agent hook 调用的入口。
 *
 * 新用法（profile 驱动）：
 *   node approvals/hook-cli.mjs event PermissionRequest claude-code
 *   node approvals/hook-cli.mjs event Notification claude-code
 *
 * 旧用法仍兼容：
 *   node approvals/hook-cli.mjs permission
 *   node approvals/hook-cli.mjs notify
 *
 * 关键行为：拿不到决定时「不输出任何内容并 exit 0」，
 * 让 Agent 回到它自己的本地提示，绝不代替用户放行。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProfile, hookTarget } from "./hook-map.mjs";

const args = process.argv.slice(2);
const MODE = args[0] || "permission";
const HOOK_EVENT = MODE === "event" ? args[1] : null;
const AGENT_ID = (MODE === "event" ? args[2] : args[1]) || process.env.MO_AGENT_AGENT || "claude-code";
const profile = loadProfile(AGENT_ID);
const TARGET = hookTarget(MODE, profile, HOOK_EVENT);
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
  if (!TARGET) process.exit(0);

  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch (error) {
    input = {};
  }

  const session = loadSession();
  if (!session) process.exit(0);

  const toolName = firstString(input, ["tool_name", "toolName"]);
  const noticeText = firstString(input, ["message", "notification_message"]);
  const payload = {
    agent: (profile && profile.id) || AGENT_ID,
    agentLabel: process.env.MO_AGENT_AGENT_LABEL || (profile && profile.label) || "Claude Code",
    sessionId: firstString(input, ["session_id", "sessionId"]),
    toolName,
    toolInput: input.tool_input || input.toolInput || null,
    title: toolName || (TARGET === "notice" ? (noticeText || "需要你的关注") : "需要授权"),
    cwd: firstString(input, ["cwd"]),
    permissionMode: firstString(input, ["permission_mode", "permissionMode"]),
  };

  if (TARGET === "notice") {
    try {
      await post(session, "/local/notify", payload);
    } catch (error) {
      /* 上报失败不影响 Agent */
    }
    process.exit(0);
  }

  if (TARGET !== "approval.pending") {
    // 其它规范事件（例如 run.completed）暂不由 hook 路径处理：
    // Claude 的完成以 transcript 为准，避免与适配器重复通知。
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
