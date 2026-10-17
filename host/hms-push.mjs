const OAUTH_URL = "https://oauth-login.cloud.huawei.com/oauth2/v3/token";
const PUSH_BASE = "https://push-api.cloud.huawei.com/v1/";

/**
 * HMS Push 通道（服务端）。
 * App 通过 /api/push-token 上报 HMS token；这里拿 App ID/Secret 换 OAuth token，
 * 再调用华为推送接口。通知类消息由系统直接展示，App 被杀也能收到。
 */
export function createHmsChannel(config, deps) {
  const opts = deps || {};
  const fetchImpl = opts.fetchImpl || fetch;
  const log = opts.log || (() => {});
  const getTokens = opts.getTokens || (() => []);
  const appId = config.appId;
  const appSecret = config.appSecret;
  let cached = null;

  async function accessToken(force) {
    if (!force && cached && cached.expiresAt > Date.now() + 60000) return cached.token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: String(appId),
      client_secret: String(appSecret),
    }).toString();
    const response = await fetchImpl(OAUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await response.json().catch(() => ({}));
    if (!data.access_token) throw new Error("HMS OAuth 失败: " + JSON.stringify(data).slice(0, 300));
    cached = {
      token: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    return cached.token;
  }

  function post(token, payload) {
    return fetchImpl(PUSH_BASE + encodeURIComponent(String(appId)) + "/messages:send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(payload),
    });
  }

  return {
    name: "hms",
    async send(intent) {
      const tokens = getTokens();
      if (!tokens.length) {
        log.warn("HMS 推送跳过：还没有设备上报 push token");
        return;
      }
      const payload = {
        message: {
          token: tokens.slice(0, 999),
          notification: {
            title: intent.title || "mo-agent",
            body: intent.body || "",
          },
          android: {
            notification: {
              // 3 = 点击通知打开 App 首页（1 需要额外 intent，2 需要 url）
              click_action: { type: 3 },
            },
          },
        },
      };

      let response = await post(await accessToken(false), payload);
      if (response.status === 401) {
        // access token 过期/失效：强制刷新后再试一次
        response = await post(await accessToken(true), payload);
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || (data.code && data.code !== "80000000")) {
        throw new Error("HMS 推送失败: " + JSON.stringify(data).slice(0, 300));
      }
      if (typeof log.info === "function") log.info("HMS 推送已发送（" + tokens.length + " 个设备）");
    },
  };
}
