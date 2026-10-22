/**
 * 钉钉 HTTP 的唯一出口：包一层 fetch，逐条记 local 计次。
 *
 * 只记“本机调用”，不判断 billable；billable 由调用方在确认成功后
 * 通过 usage.recordBillable() 累加，避免把业务成功与 HTTP 成功混在一起。
 */

function apiName(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.pathname.replace(/^\/+/, "") || parsed.hostname;
  } catch (error) {
    return "unknown";
  }
}

export function createDingTalkFetch(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || fetch;
  const meter = opts.meter;
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;

  if (!meter || typeof meter.record !== "function") {
    throw new Error("dingtalk-http: meter.record required");
  }

  return async function dingTalkFetch(url, init, meta) {
    const info = meta || {};
    const api = info.api || apiName(url);
    const category = info.category || "api";
    const source = info.source || "host";
    const retry = !!info.retry;
    const started = now();
    try {
      const response = await fetchImpl(url, init);
      const ms = now() - started;
      meter.record({ api, category, source, ok: !!response.ok, ms, retry });
      if (log.debug) log.debug("dingtalk http " + api + " -> " + response.status + " (" + ms + "ms)");
      return response;
    } catch (error) {
      const ms = now() - started;
      meter.record({ api, category, source, ok: false, ms, retry });
      if (log.warn) log.warn("dingtalk http " + api + " 失败: " + (error && error.message ? error.message : error));
      throw error;
    }
  };
}

export { apiName };
