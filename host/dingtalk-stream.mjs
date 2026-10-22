import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";

/**
 * 钉钉 Stream 连接封装（官方 dingtalk-stream SDK）。
 *
 * SDK 没有 onStatus 事件，这里用 1s 轮询把 connected/registered/reconnecting
 * 映射成统一状态，供 bot 与监控屏使用。
 */

const STATUS_POLL_MS = 1000;

function computeStatus(client) {
  if (client.reconnecting) return "reconnecting";
  // WebSocket 已打开就视为已连接。SDK 的 registered 标记依赖 REGISTERED 系统帧，
  // 某些网络下该帧会缺失，但收发消息仍然正常，不能因此显示“未连接”。
  if (client.connected) return "connected";
  return "disconnected";
}

export function createDingTalkStream(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : (() => {});
  const onMessage = typeof opts.onMessage === "function" ? opts.onMessage : (() => {});
  const onError = typeof opts.onError === "function" ? opts.onError : (() => {});

  const client = opts.client || new DWClient({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    keepAlive: true,
    debug: !!opts.debug,
  });

  let status = "disconnected";
  let timer = null;
  let stopped = false;

  function setStatus(next) {
    if (next === status) return;
    status = next;
    try { onStatus(status); } catch (error) { /* isolate */ }
  }

  function tick() {
    if (!stopped) setStatus(computeStatus(client));
  }

  client.registerCallbackListener(TOPIC_ROBOT, (frame) => {
    try {
      onMessage(frame);
    } catch (error) {
      onError(error);
    }
  });

  return {
    client,

    async start() {
      stopped = false;
      setStatus("connecting");
      try {
        await client.connect();
      } catch (error) {
        onError(error);
        log.warn("钉钉 Stream 连接失败: " + (error && error.message ? error.message : error));
      }
      if (!timer) {
        timer = setInterval(tick, STATUS_POLL_MS);
        if (typeof timer.unref === "function") timer.unref();
      }
      tick();
    },

    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try { client.disconnect(); } catch (error) { /* ignore */ }
      setStatus("stopped");
    },

    ack(messageId, result) {
      try {
        client.socketCallBackResponse(messageId, result || {});
      } catch (error) {
        log.warn("钉钉 Stream ACK 失败: " + (error && error.message ? error.message : error));
      }
    },

    getStatus() {
      return status;
    },

    /** 测试/监控用：立即刷新一次状态（正常由 1s 定时器驱动）。 */
    refresh() {
      tick();
      return status;
    },

    isConnected() {
      return status === "connected";
    },
  };
}
