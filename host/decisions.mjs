/**
 * 统一的「决定」入口。
 *
 * 手机通知上的「允许一次 / 拒绝」只带一个 id，不区分这条待办来自哪里：
 *  - hook 型 Agent（Claude Code / Qoder CN / WorkBuddy）→ approvals/broker.mjs
 *  - DSH 原生 approval/request（其它 Agent 也走 DSH 时）→ adapters/dsh.mjs
 *
 * 以前 /api/approve 只问 broker，于是 DSH 的通知按钮点了没反应：
 * 卡片/通知会出现，但 Agent 侧永远等不到结果。这里按 id 依次尝试两条链路。
 */

/** 把 broker 风格的决定翻译成 DSH 的 approval outcome。 */
export function approvalOutcomeFor(decision) {
  const value = String(decision || "").toLowerCase();
  if (value === "allowed-once" || value.indexOf("allow") === 0) return "allowed-once";
  if (value === "rejected" || value.indexOf("reject") === 0) return "rejected";
  if (value === "cancelled" || value === "canceled" || value === "cancel") return "cancelled";
  return "";
}

export function createDecisionRouter(options) {
  const opts = options || {};
  const broker = opts.broker || null;
  const log = opts.log || { info: function () {}, warn: function () {} };
  const getMonitor = typeof opts.getMonitor === "function" ? opts.getMonitor : function () { return opts.monitor || null; };
  const getDsh = typeof opts.getDsh === "function" ? opts.getDsh : function () { return opts.dsh || null; };

  /** 先交给 broker（同步），没命中再看是不是 DSH 原生待办（异步回答）。 */
  async function decide(id, decision, extra) {
    if (!id || !decision) return false;

    if (broker && typeof broker.decide === "function" && broker.decide(id, decision, extra)) {
      return true;
    }

    const monitor = getMonitor();
    const dsh = getDsh();
    const pending = monitor && monitor.pending && typeof monitor.pending.get === "function"
      ? monitor.pending.get(id)
      : null;
    if (!pending) return false;

    // 目前通知按钮只承诺「授权」；提问需要结构化答案，走 /api/answer。
    if (pending.kind !== "approval") return false;
    if (!dsh || typeof dsh.answer !== "function") return false;

    const outcome = approvalOutcomeFor(decision);
    if (!outcome) return false;

    try {
      await dsh.answer(id, { kind: "result", value: outcome });
    } catch (error) {
      log.warn("回答 DSH 待办失败 " + id + ": " + (error && error.message ? error.message : String(error)));
      return false;
    }
    if (monitor && typeof monitor.resolvePending === "function") {
      monitor.resolvePending(id, "answered");
    }
    log.info("手机已应答 DSH 待办 " + id + " -> " + outcome);
    return true;
  }

  return { decide };
}
