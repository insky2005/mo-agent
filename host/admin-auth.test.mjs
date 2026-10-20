import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_COOKIE, adminCookieValue, grantAdminCookie, isAdminAuthed, readCookie } from "./admin-auth.mjs";

const TOKEN = "local-token-for-test";

function req(headers) {
  return { headers: headers || {} };
}

function res() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[String(name).toLowerCase()] = String(value); },
  };
}

test("readCookie 解析多个 Cookie 并忽略无关键", () => {
  assert.equal(readCookie(req({ cookie: "a=1; " + ADMIN_COOKIE + "=" + TOKEN + "; b=2" }), ADMIN_COOKIE), TOKEN);
  assert.equal(readCookie(req({ cookie: "" }), ADMIN_COOKIE), "");
});

test("isAdminAuthed 接受请求头 / query / Cookie 三种令牌", () => {
  assert.equal(isAdminAuthed(req({ "x-mo-agent-local": TOKEN }), new URL("http://x/setup"), TOKEN), true);
  assert.equal(isAdminAuthed(req(), new URL("http://x/setup?token=" + TOKEN), TOKEN), true);
  assert.equal(isAdminAuthed(req({ cookie: ADMIN_COOKIE + "=" + adminCookieValue(TOKEN) }), new URL("http://x/setup"), TOKEN), true);
});

test("isAdminAuthed 拒绝错误令牌、空令牌和缺失的 host 令牌", () => {
  assert.equal(isAdminAuthed(req({ "x-mo-agent-local": "wrong" }), new URL("http://x/setup"), TOKEN), false);
  assert.equal(isAdminAuthed(req(), new URL("http://x/setup?token=wrong"), TOKEN), false);
  assert.equal(isAdminAuthed(req({ cookie: ADMIN_COOKIE + "=wrong" }), new URL("http://x/setup"), TOKEN), false);
  assert.equal(isAdminAuthed(req({ "x-mo-agent-local": TOKEN }), new URL("http://x/setup"), ""), false);
});

test("query / 请求头令牌换 HttpOnly Cookie", async () => {
  const response = res();
  grantAdminCookie(req(), response, TOKEN, new URL("http://x/setup?token=" + TOKEN));
  assert.match(response.headers["set-cookie"], new RegExp(ADMIN_COOKIE + "=" + adminCookieValue(TOKEN)));
  assert.doesNotMatch(response.headers["set-cookie"], new RegExp(TOKEN), "Cookie 不应直放本机令牌");
  assert.match(response.headers["set-cookie"], /HttpOnly/);
  assert.match(response.headers["set-cookie"], /SameSite=Strict/);

  const response2 = res();
  grantAdminCookie(req({ "x-mo-agent-local": TOKEN }), response2, TOKEN, new URL("http://x/setup"));
  assert.match(response2.headers["set-cookie"], new RegExp(ADMIN_COOKIE + "=" + adminCookieValue(TOKEN)));
});

test("仅 Cookie、错误 query、已有 Cookie 时不重复下发", async () => {
  const onlyCookie = res();
  grantAdminCookie(req({ cookie: ADMIN_COOKIE + "=" + adminCookieValue(TOKEN) }), onlyCookie, TOKEN, new URL("http://x/setup"));
  assert.equal(onlyCookie.headers["set-cookie"], undefined);

  const wrong = res();
  grantAdminCookie(req(), wrong, TOKEN, new URL("http://x/setup?token=wrong"));
  assert.equal(wrong.headers["set-cookie"], undefined);
});
