import { createHmac, timingSafeEqual } from "node:crypto";

// 管理页（设置 / 一键配置 / 配对 / 日志）的鉴权。
// 页面只允许从回环地址打开，并且必须带上本机令牌：
//   - 桌面壳打开时把令牌放在 ?token= 里；
//   - 首次通过 query / 请求头进来后换成 HttpOnly Cookie，
//     页面内的链接、二维码图片和 fetch 就不用每条都带令牌。
export const ADMIN_COOKIE = "mo_agent_admin";

function headerValue(req, name) {
  const raw = req && req.headers ? req.headers[name] : "";
  return Array.isArray(raw) ? raw[0] : raw;
}

export function readCookie(req, name) {
  const raw = headerValue(req, "cookie");
  if (!raw) return "";
  for (const part of String(raw).split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch (error) {
      return "";
    }
  }
  return "";
}

function tokenEquals(left, right) {
  const a = Buffer.from(String(left == null ? "" : left), "utf8");
  const b = Buffer.from(String(right == null ? "" : right), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function queryToken(url) {
  return url && url.searchParams ? url.searchParams.get("token") : "";
}

/** Cookie 里不直接放本机令牌：换成一个只用派生值，避免端口级 Cookie 泄漏后能调 /local API。 */
export function adminCookieValue(token) {
  if (!token) return "";
  return createHmac("sha256", String(token)).update("mo-agent-admin-cookie-v1").digest("base64url");
}

/** 请求是否已经通过本机令牌鉴权（请求头 / query / Cookie 任一）。 */
export function isAdminAuthed(req, url, token) {
  if (!token) return false;
  if (tokenEquals(headerValue(req, "x-mo-agent-local"), token)) return true;
  if (tokenEquals(queryToken(url), token)) return true;
  return tokenEquals(readCookie(req, ADMIN_COOKIE), adminCookieValue(token));
}

/** 用 query / 请求头里的令牌换一张 HttpOnly 会话 Cookie，供页面内部请求复用。 */
export function grantAdminCookie(req, res, token, url) {
  if (!token || !res || typeof res.setHeader !== "function") return;
  const cookie = adminCookieValue(token);
  if (tokenEquals(readCookie(req, ADMIN_COOKIE), cookie)) return;
  const viaHeader = tokenEquals(headerValue(req, "x-mo-agent-local"), token);
  const viaQuery = tokenEquals(queryToken(url), token);
  if (!viaHeader && !viaQuery) return;
  res.setHeader(
    "set-cookie",
    ADMIN_COOKIE + "=" + encodeURIComponent(cookie) + "; Path=/; HttpOnly; SameSite=Strict",
  );
}
