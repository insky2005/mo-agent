import { EVENT } from "../core/contract.mjs";
import { ROUTER_SESSION_ID } from "../core/router.mjs";
import { routerSessionPayload } from "../cli/lib/router-manager.mjs";

/**
 * host 侧的会话接管。
 *
 * Router 的 pid 由"启动它的那个进程"持有——可能是 mo（CLI），也可能是上一次的 host。
 * host 启动时不重启它，只做两件事：发现活着就注入 hub（这样手机/监控能看见它），
 * 以及把控制面（/local/router/*）接上。
 */
export function adoptRouterSession(options) {
  const opts = options || {};
  const hub = opts.hub;
  const manager = opts.manager;
  const log = opts.log || { info() {}, warn() {} };
  if (!hub || !manager) return { adopted: false, reason: "缺少 hub 或 manager" };

  let status;
  try {
    status = manager.status();
  } catch (error) {
    log.warn("接管 Router 会话失败：" + (error && error.message ? error.message : error));
    return { adopted: false, reason: "status 失败" };
  }
  if (!status || !status.running) return { adopted: false, reason: "未运行" };

  hub.emit(
    EVENT.SESSION_UPSERT,
    routerSessionPayload({
      cwd: status.cwd,
      pid: status.pid,
      updatedAt: Date.now(),
    }),
  );
  log.info("接管已运行的指挥台（pid " + status.pid + "）");
  return { adopted: true, pid: status.pid, sessionId: ROUTER_SESSION_ID };
}
