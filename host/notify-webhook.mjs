import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createHmsChannel } from "./hms-push.mjs";

/**
 * Webhook 通知通道：把 host 的统一 notify 事件转成第三方服务的请求。
 * 目前支持：
 *   bark     iPhone（api.day.app）
 *   dingtalk 钉钉机器人
 *   wecom    企业微信群机器人
 *   feishu   飞书自定义机器人
 *   generic  任意接收 JSON 的地址
 *
 * 只负责「拼请求」，实际发送由 createWebhookChannel 用 fetch 完成；
 * 这样格式可以单独测试，也能注入假的 fetch。
 */

function compact(value) {
  const out = {};
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") out[key] = value[key];
  }
  return out;
}

function barkLevel(severity) {
  return severity === "critical" ? "critical" : "passive";
}

/** Bark：给了 deviceKey 走 POST /push，否则按 https://api.day.app/<key>/<标题>/<内容> 路径方式。 */
export function barkRequest(intent, options) {
  const opts = options || {};
  const title = intent.title || "mo-agent";
  const text = intent.body || "";
  const level = opts.level || barkLevel(intent.severity);
  const sound = opts.sound || (intent.severity === "critical" ? "alarm" : undefined);
  const group = opts.group || "mo-agent";
  const common = compact({ level, sound, group, icon: opts.icon, url: opts.openUrl });

  if (opts.deviceKey) {
    const server = (opts.server || "https://api.day.app").replace(/\/+$/, "");
    const body = compact(Object.assign({ device_key: opts.deviceKey, title, body: text }, common));
    return {
      url: server + "/push",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  const base = String(opts.url || "").replace(/\/+$/, "");
  const query = new URLSearchParams();
  for (const key of Object.keys(common)) query.set(key, String(common[key]));
  const qs = query.toString();
  return {
    url: base + "/" + encodeURIComponent(title) + "/" + encodeURIComponent(text) + (qs ? "?" + qs : ""),
    method: "GET",
  };
}

function markdownText(intent) {
  return "### " + (intent.title || "mo-agent") + "\n\n" + (intent.body || "");
}

/** 钉钉机器人：markdown 消息；配了 secret 就加时间戳签名。 */
export function dingtalkRequest(intent, options) {
  const opts = options || {};
  let url = opts.url;
  if (opts.secret) {
    const timestamp = Date.now();
    const stringToSign = timestamp + "\n" + opts.secret;
    const sign = createHmac("sha256", opts.secret).update(stringToSign).digest("base64");
    const sep = url.includes("?") ? "&" : "?";
    url = url + sep + "timestamp=" + timestamp + "&sign=" + encodeURIComponent(sign);
  }
  return {
    url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { title: intent.title || "mo-agent", text: markdownText(intent) } }),
  };
}

/** 企业微信机器人 */
export function wecomRequest(intent, options) {
  return {
    url: (options || {}).url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdownText(intent) } }),
  };
}

/** 飞书自定义机器人 */
export function feishuRequest(intent, options) {
  return {
    url: (options || {}).url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text: (intent.title || "mo-agent") + "\n" + (intent.body || "") } }),
  };
}

/** 通用：把整个通知意图作为 JSON POST 出去。 */
export function genericRequest(intent, options) {
  return {
    url: (options || {}).url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intent),
  };
}

const BUILDERS = {
  bark: barkRequest,
  dingtalk: dingtalkRequest,
  wecom: wecomRequest,
  feishu: feishuRequest,
  generic: genericRequest,
};

export function buildRequest(config, intent) {
  const builder = BUILDERS[config.type] || genericRequest;
  return builder(intent, config);
}

/** 一个通道实例：send(intent) 发出请求，失败抛错（由 Notifier 记日志）。 */
export function createWebhookChannel(config, deps) {
  const options = deps || {};
  const fetchImpl = options.fetchImpl || fetch;
  return {
    name: "webhook:" + (config.type || "generic"),
    async send(intent) {
      const req = buildRequest(config, intent);
      if (!req || !req.url) return;
      const response = await fetchImpl(req.url, {
        method: req.method || "POST",
        headers: req.headers,
        body: req.body,
      });
      if (response && response.ok === false) throw new Error("HTTP " + response.status);
    },
  };
}

/**
 * 读取通道配置：
 *  1) 配置文件（默认 ~/.mo-agent/notify.json，可被 MO_AGENT_NOTIFY_FILE 覆盖）
 *  2) 环境变量 MO_AGENT_NOTIFY_WEBHOOKS（JSON 数组，用于临时/调试）
 * 两者都会生效。
 */
export function loadChannelConfigs(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const env = opts.env || process.env;
  const file = opts.file || path.join(os.homedir(), ".mo-agent", "notify.json");
  const configs = [];

  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed) ? parsed : parsed.channels;
      if (Array.isArray(list)) configs.push(...list);
    }
  } catch (error) {
    log.warn("读取通知配置失败（" + file + "）: " + (error && error.message ? error.message : error));
  }

  if (env.MO_AGENT_NOTIFY_WEBHOOKS) {
    try {
      const list = JSON.parse(env.MO_AGENT_NOTIFY_WEBHOOKS);
      if (Array.isArray(list)) configs.push(...list);
    } catch (error) {
      log.warn("MO_AGENT_NOTIFY_WEBHOOKS 不是合法 JSON，已忽略");
    }
  }

  return configs.filter((config) => config && typeof config === "object");
}

/** 只要 webhook 类型（bark/dingtalk/wecom/feishu/generic）。 */
export function loadWebhookChannels(options) {
  const opts = options || {};
  return loadChannelConfigs(opts)
    .filter((config) => config.type !== "hms" && config.url)
    .map((config) => createWebhookChannel(config, { log: opts.log }));
}

/** 全部通道，包括 HMS。 */
export function loadNotifyChannels(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const getPushTokens = opts.getPushTokens || (() => []);
  const result = [];
  for (const config of loadChannelConfigs(opts)) {
    if (config.type === "hms") {
      if (!config.appId || !config.appSecret) {
        log.warn("HMS 通道缺少 appId/appSecret，已跳过");
        continue;
      }
      result.push(createHmsChannel(config, { log, getTokens: getPushTokens, fetchImpl: opts.fetchImpl }));
    } else if (config.url) {
      result.push(createWebhookChannel(config, { log }));
    }
  }
  return result;
}
