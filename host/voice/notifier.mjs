/**
 * 把 critical 通知念出来。
 *
 * 授权不走这里：授权由语音草稿流程负责念动作/目标/口令，
 * 再从同一条通道收回答，重复播报只会让人听不清。
 */
export function createVoiceNotifier(options) {
  const opts = options || {};
  const speaker = opts.speaker;
  const log = opts.log || { warn: function () {} };
  if (typeof speaker !== "function") throw new Error("voice notifier 需要 speaker 函数");

  return {
    name: "voice",
    send(notification) {
      if (!notification || notification.severity !== "critical") return;
      if (notification.kind === "approval") return;

      const title = String(notification.title || "Agent 通知");
      const body = notification.body ? "。" + String(notification.body) : "";
      return speaker(title + body).catch(function (error) {
        if (typeof log.warn === "function") {
          log.warn("语音播报失败: " + (error && error.message ? error.message : String(error)));
        }
      });
    },
  };
}
