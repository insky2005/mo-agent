import { randomBytes } from "node:crypto";

/**
 * 扫码配对：签发一次性、短时效的配对令牌。
 *
 * 相比 6 位配对码，二维码里的令牌：
 *  - 一次即焚（兑换后立即失效并换新）
 *  - 有时效（默认 5 分钟）
 *  - 不依赖用户输入，手机上扫一下就走完
 */
export class PairingManager {
  constructor(options) {
    const opts = options || {};
    this.ttlMs = opts.ttlMs || 5 * 60 * 1000;
    this.log = opts.log || (() => {});
    this.current = null;
    this.redeemedCount = 0;
  }

  issue() {
    const token = randomBytes(18).toString("base64url");
    this.current = { token, issuedAt: Date.now(), expiresAt: Date.now() + this.ttlMs };
    this.log.debug("已签发配对令牌，有效期 " + Math.round(this.ttlMs / 1000) + "s");
    return this.current;
  }

  /** 取当前有效令牌；没有或已过期就换一张新的。 */
  peek() {
    if (!this.current || Date.now() > this.current.expiresAt) return this.issue();
    return this.current;
  }

  /** 兑换：成功即作废。 */
  redeem(token) {
    const current = this.current;
    if (!current || !token) return false;
    if (current.token !== token) return false;
    if (Date.now() > current.expiresAt) {
      this.current = null;
      return false;
    }
    this.current = null;
    this.redeemedCount += 1;
    return true;
  }

  status() {
    return { remainingMs: this.remainingMs(), redeemedCount: this.redeemedCount };
  }

  remainingMs() {
    if (!this.current) return 0;
    return Math.max(0, this.current.expiresAt - Date.now());
  }
}

/** 二维码里承载的配对串。 */
export function buildPairPayload(baseUrl, token) {
  return "mo-agent://pair?u=" + encodeURIComponent(baseUrl) + "&t=" + encodeURIComponent(token);
}

/** 从扫码结果解析配对串；兼容纯 URL 形式。 */
export function parsePairPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const match = raw.match(/^mo-agent:\/\/pair\?(.*)$/i);
  if (match) {
    const params = new URLSearchParams(match[1]);
    return { baseUrl: params.get("u") || "", token: params.get("t") || "" };
  }
  const generic = raw.match(/^https?:\/\//i);
  if (generic) {
    try {
      const url = new URL(raw);
      return { baseUrl: url.origin, token: url.searchParams.get("t") || "" };
    } catch (error) {
      return null;
    }
  }
  return null;
}

/** 挑出适合给手机访问的网卡地址（排除虚拟网卡）。 */
export function candidateAddresses(list) {
  const noisy = /^(bridge|vmnet|utun|awdl|llw|tun|tap|docker|veth|anpi|ipsec)/i;
  const preferred = [];
  const others = [];
  for (const item of list || []) {
    if (noisy.test(item.name)) others.push(item);
    else preferred.push(item);
  }
  return preferred.concat(others);
}
