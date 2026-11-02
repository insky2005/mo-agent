import { MoError } from "../../core/errors.mjs";
import {
  ROUTER_ERROR,
  ROUTER_SESSION_ID,
  ROUTER_SESSION_NAME,
  ROUTER_TOOL_SPEC,
  validateToolSpec,
} from "../../core/router.mjs";

/**
 * 组装 Pi 作为 Router 的启动参数（纯函数，不 spawn、不读文件）。
 *
 * 这里是"Router 没有手"的唯一落地点：工具面在启动参数上收窄，不靠提示词。
 * 见 docs/spec/router.md §5.1 / §5.2。
 *
 * @param {{
 *   runtimeBin: string,      // 私有运行时里的 pi 可执行文件
 *   cwd: string,             // Router 的工作目录（workbench）
 *   contractPath: string,    // ROUTER.md 绝对路径
 *   agentDir: string,        // PI_CODING_AGENT_DIR（必须是私有目录）
 *   sessionId?: string,
 *   sessionName?: string,
 *   sessionDir?: string,
 *   extensionPath?: string,  // mo 控制扩展
 *   offline?: boolean,
 *   toolSpec?: string,
 * }} options
 * @returns {{command: string, args: string[], env: Record<string,string>, cwd: string}}
 */
export function buildPiArgv(options) {
  const opts = options || {};

  if (!opts.runtimeBin) {
    throw new MoError(ROUTER_ERROR.RUNTIME_MISSING, "缺少运行时可执行文件路径", {
      hint: "先 mo router runtime install",
    });
  }
  if (!opts.cwd) {
    throw new MoError(ROUTER_ERROR.START_FAILED, "缺少 Router 工作目录");
  }
  if (!opts.contractPath) {
    throw new MoError(ROUTER_ERROR.START_FAILED, "缺少契约文件（ROUTER.md）路径");
  }
  if (!opts.agentDir) {
    throw new MoError(ROUTER_ERROR.START_FAILED, "缺少私有配置目录（PI_CODING_AGENT_DIR）", {
      hint: "Router 必须使用 mo 自己的配置目录，不能回落用户全局配置",
    });
  }

  const toolSpec = opts.toolSpec === undefined ? ROUTER_TOOL_SPEC : String(opts.toolSpec);
  const checked = validateToolSpec(toolSpec);
  if (!checked.ok) {
    throw new MoError(ROUTER_ERROR.RUNTIME_UNSUPPORTED, "工具面不合法：" + checked.reason, {
      offending: checked.offending || null,
    });
  }

  const args = [
    "--session-id",
    String(opts.sessionId || ROUTER_SESSION_ID),
    // Router 不加载任何技能：它的契约是 ROUTER.md（--append-system-prompt），
    // 通用技能里全是 shell 命令示例，而 Router 没有 shell，读了只会误导。
    // 技能发现是全局的（含 ~/.agents/skills），所以必须显式关掉。
    "--no-skills",
    "--name",
    String(opts.sessionName || ROUTER_SESSION_NAME),
    "--tools",
    toolSpec,
    "--append-system-prompt",
    String(opts.contractPath),
  ];
  // 不再传 --provider/--model：模型与思考等级放 settings.json。
  // 传命令行参数会把用户在 TUI 里 /model 的选择每次启动都覆盖掉。
  if (opts.extensionPath) args.push("-e", String(opts.extensionPath));

  const env = { PI_CODING_AGENT_DIR: String(opts.agentDir) };
  if (opts.sessionDir) env.PI_CODING_AGENT_SESSION_DIR = String(opts.sessionDir);
  if (opts.offline) env.PI_OFFLINE = "1";

  return { command: String(opts.runtimeBin), args, env, cwd: String(opts.cwd) };
}
