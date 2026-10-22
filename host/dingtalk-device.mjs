import { setTimeout as delay } from "node:timers/promises";

/**
 * 钉钉开放平台 device-code 注册。
 *
 * 复用开放平台的扫码注册流程（init / begin / poll），扫码后自动创建
 * 「企业内部应用 + 机器人」，直接返回 client_id / client_secret。
 * 不依赖外部 CLI，也不需要公网回调地址。
 *
 * 参考实现：helloharness core/lib/dingtalk-device.js
 */

export const DEFAULT_BASE_URL = "https://oapi.dingtalk.com";
export const DEFAULT_SOURCE = "MO_AGENT";
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_EXPIRES_IN = 7200;
export const DEFAULT_INTERVAL = 5;
export const DEFAULT_RETRY_WINDOW_MS = 120000;

function withSource(uri, source) {
  const url = new URL(uri);
  url.searchParams.set("source", source);
  return url.toString();
}

async function post(fetchImpl, url, body, timeoutMs) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error("device-code HTTP " + response.status + ": " + text.slice(0, 200));
  }
  const data = await response.json().catch(() => ({}));
  if (!data || data.errcode !== 0) {
    const reason = (data && (data.errmsg || data.message)) || "unknown";
    const code = data && data.errcode;
    const error = new Error("device-code: " + reason + (code === undefined ? "" : " (errcode=" + code + ")"));
    error.errcode = code;
    throw error;
  }
  return data;
}

/**
 * 开始注册：init 拿 nonce，begin 拿 device_code 和二维码地址。
 * 返回 { deviceCode, verificationUriComplete, expiresInSeconds, intervalSeconds, source }。
 */
export async function beginRegistration(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || fetch;
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const source = opts.source || DEFAULT_SOURCE;
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

  const init = await post(fetchImpl, baseUrl + "/app/registration/init", { source }, timeoutMs);
  const nonce = String((init && init.nonce) || "").trim();
  if (!nonce) throw new Error("device-code: [init] missing nonce");

  const begin = await post(fetchImpl, baseUrl + "/app/registration/begin", { nonce }, timeoutMs);
  const deviceCode = String((begin && begin.device_code) || "").trim();
  const verificationUri = String((begin && begin.verification_uri_complete) || "").trim();
  if (!deviceCode) throw new Error("device-code: [begin] missing device_code");
  if (!verificationUri) throw new Error("device-code: [begin] missing verification_uri_complete");

  return {
    deviceCode,
    verificationUriComplete: withSource(verificationUri, source),
    expiresInSeconds: Number(begin.expires_in) > 0 ? Number(begin.expires_in) : DEFAULT_EXPIRES_IN,
    intervalSeconds: Number(begin.interval) > 0 ? Number(begin.interval) : DEFAULT_INTERVAL,
    source,
  };
}

/**
 * 轮询直到扫码成功。
 * @returns {Promise<{ clientId: string, clientSecret: string }>}
 */
export async function waitForCredentials(registration, options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || fetch;
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const retryWindowMs = Number(opts.retryWindowMs) || DEFAULT_RETRY_WINDOW_MS;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => delay(ms));

  if (!registration || !registration.deviceCode) {
    throw new Error("device-code: registration.deviceCode required");
  }

  const intervalMs = Math.max(1, Number(registration.intervalSeconds) || DEFAULT_INTERVAL) * 1000;
  const deadline = now() + (Number(registration.expiresInSeconds) || DEFAULT_EXPIRES_IN) * 1000;
  let retryStart = 0;

  while (now() < deadline) {
    await sleep(intervalMs);

    let polled;
    try {
      polled = await post(fetchImpl, baseUrl + "/app/registration/poll", { device_code: registration.deviceCode }, timeoutMs);
    } catch (error) {
      if (!retryStart) retryStart = now();
      if (now() - retryStart < retryWindowMs) continue;
      throw error;
    }

    const status = String((polled && polled.status) || "").trim().toUpperCase();
    if (status === "WAITING") {
      retryStart = 0;
      continue;
    }
    if (status === "SUCCESS") {
      const clientId = String(polled.client_id || "").trim();
      const clientSecret = String(polled.client_secret || "").trim();
      if (!clientId || !clientSecret) {
        throw new Error("device-code: SUCCESS but missing client_id/client_secret");
      }
      return { clientId, clientSecret };
    }
    if (status === "FAIL") {
      throw new Error("device-code: authorization failed" + (polled.fail_reason ? ": " + polled.fail_reason : ""));
    }
    if (status === "EXPIRED") {
      throw new Error("device-code: authorization expired, scan again");
    }

    if (!retryStart) retryStart = now();
    if (now() - retryStart < retryWindowMs) continue;
    throw new Error("device-code: unknown poll status " + (status || "(empty)"));
  }

  throw new Error("device-code: authorization timeout");
}
