import { daemonCommand } from "./daemon.mjs";
import { routerCommand } from "./router.mjs";

/**
 * mo serve —— 常驻服务的唯一入口（E4）。
 *
 * daemon（host：手机/钉钉/监控屏）与 router（指挥台）本来是父子关系，
 * 却各有自己的一套 start/stop/status。这里把它们收成一组：
 *   mo serve start|stop|status|open   → host
 *   mo serve router <子命令>          → 指挥台
 * 旧的 mo daemon / mo router 继续可用（别名），不做破坏性删除。
 */
export async function serveCommand(ctx, args) {
  const sub = args.positional[0];

  if (sub === "router") {
    return routerCommand(ctx, { positional: args.positional.slice(1), options: args.options });
  }

  if (sub === "restart") {
    // 先看有没有在跑：没跑就直接 start，避免对别人的进程做无谓的 stop。
    let running = false;
    try {
      running = (await daemonCommand(ctx, { positional: ["status"], options: args.options })) === 0;
    } catch {
      running = false;
    }
    if (running) {
      try {
        await daemonCommand(ctx, { positional: ["stop"], options: args.options });
      } catch {
        // 停不掉也继续：start 是幂等的，至少不会把状态弄坏
      }
    }
    return daemonCommand(ctx, { positional: ["start"], options: args.options });
  }

  return daemonCommand(ctx, args);
}
