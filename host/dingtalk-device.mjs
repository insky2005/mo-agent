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
export const DEFAULT_SOURCE = "openClaw";
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_EXPIRES_IN = 7200;
export const DEFAULT_INTERVAL = 5;
export const DEFAULT_RETRY_WINDOW_MS = 120000;

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
  const source = opts.source || process.env.MO_AGENT_DINGTALK_REGISTRATION_SOURCE || DEFAULT_SOURCE;
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
    // 必须原样使用钉钉返回的地址：额外拼 source 会让钉钉判定“创建来源无效”。
    verificationUriComplete: verificationUri,
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
  const shouldStop = typeof opts.shouldStop === "function" ? opts.shouldStop : null;

  if (!registration || !registration.deviceCode) {
    throw new Error("device-code: registration.deviceCode required");
  }

  const intervalMs = Math.max(1, Number(registration.intervalSeconds) || DEFAULT_INTERVAL) * 1000;
  const deadline = now() + (Number(registration.expiresInSeconds) || DEFAULT_EXPIRES_IN) * 1000;
  let retryStart = 0;

  while (now() < deadline) {
    if (shouldStop && shouldStop()) throw new Error("device-code: canceled");
    await sleep(intervalMs);
    if (shouldStop && shouldStop()) throw new Error("device-code: canceled");

    let polled;
    try {
      polled = await post(fetchImpl, baseUrl + "/app/registration/poll", { device_code: registration.deviceCode }, timeoutMs);
    } catch (error) {
      if (!retryStart) retryStart = now();
      if (now() - retryStart < retryWindowMs) continue;
      throw error;
    }

    const clean = (value) => (typeof value === "string" ? value.trim() : "");
    const status = clean(polled && polled.status).toUpperCase();
    const clientId = clean(polled && polled.client_id);
    const clientSecret = clean(polled && polled.client_secret);

    // SCANNED / CREATING / PUBLISHING / APPROVING 都是中间态；
    // 只要 client_id + client_secret 已下发，就算成功。
    const detail = {
      status,
      errcode: polled && polled.errcode,
      errmsg: clean(polled && polled.errmsg),
      failReason: clean(polled && polled.fail_reason),
    };
    if (clientId && clientSecret) {
      if (typeof opts.onStatus === "function") opts.onStatus(status || "SUCCESS", detail);
      return {
        clientId,
        clientSecret,
        robotCode: clean(polled && polled.robot_code),
        mode: clean(polled && polled.mode),
        status: status || "SUCCESS",
      };
    }
    if (status === "FAIL") {
      if (typeof opts.onStatus === "function") opts.onStatus(status, detail);
      const reason = clean(polled && polled.fail_reason);
      throw new Error("device-code: authorization failed" + (reason ? ": " + reason : ""));
    }
    if (status === "EXPIRED") {
      if (typeof opts.onStatus === "function") opts.onStatus(status, detail);
      throw new Error("device-code: authorization expired, scan again");
    }

    if (typeof opts.onStatus === "function" && status) opts.onStatus(status, detail);
    retryStart = 0;
    continue;
    throw new Error("device-code: unknown poll status " + (status || "(empty)"));
  }

  throw new Error("device-code: authorization timeout");
}
