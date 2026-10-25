/**
 * 授权请求：纯逻辑，不碰文件系统。
 * 见 docs/spec/workbench-flow.md B4。确认 = 发起请求；批准 = 人来做。
 */
import crypto from "node:crypto";

export const REQUEST_STATUS = ["pending", "approved", "rejected", "stale", "expired"];

/** 24h 未批 → 过期（B4.4） */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** 稳定序列化：键排序，避免同一张卡算出不同指纹 */
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
}

/**
 * 卡片指纹：只覆盖"内容"，不含 status / updated / verified。
 * 批准时比对它，"人批的到底是哪张卡"才可验证。
 */
export function cardDigest({ meta, body }) {
  const payload = {
    title: meta.title || "",
    project: meta.project || "",
    body: String(body || "").trim(),
    verify: meta.verify || [],
    workdir: meta.workdir || ".",
    receipt: meta.receipt || null,
    timeout: meta.timeout || null,
    assignee: meta.assignee || "auto",
    exec: meta.exec || null,
    retries: meta.retries ?? null,
    on_fail: meta.on_fail ?? null,
    budget: meta.budget ?? null,
  };
  return crypto.createHash("sha256").update(stable(payload)).digest("hex");
}

export function makeRequest({ id, taskId, project, projectRoot, title, digest, requestedBy, at = new Date().toISOString(), ttlMs = DEFAULT_TTL_MS }) {
  const expiresAt = new Date(new Date(at).getTime() + ttlMs).toISOString();
  return {
    v: 1,
    id,
    kind: "task.confirm",
    taskId,
    project: project || null,
    projectRoot: projectRoot || null,
    title: title || "",
    cardHash: digest,
    at,
    expiresAt,
    status: "pending",
    decidedAt: null,
    decidedBy: null,
    requestedBy: requestedBy || { actor: "agent" },
  };
}

export function isExpired(request, now = Date.now()) {
  return Boolean(request) && request.status === "pending" && new Date(request.expiresAt).getTime() <= now;
}

export function expire(request, at = new Date().toISOString()) {
  return { ...request, status: "expired", decidedAt: at, decidedBy: { channel: "system" } };
}

export function decide(request, { status, channel, at = new Date().toISOString(), note }) {
  if (!["approved", "rejected", "stale"].includes(status)) {
    throw new Error("未知的批准结果：" + status);
  }
  return {
    ...request,
    status,
    decidedAt: at,
    decidedBy: { channel: channel || "unknown", ...(note ? { note } : {}) },
  };
}

/** 人批的卡已经不是现在这张卡 */
export function isStale(request, currentDigest) {
  return Boolean(request) && request.cardHash !== currentDigest;
}
