/**
 * Router 的能力面策略（纯逻辑，不碰 IO）。
 *
 * 决策：[ADR-0004](../docs/adr/adr-0004-private-router-runtime.md)
 * 落地：[spec/router.md](../docs/spec/router.md) §5
 *
 * 这里只回答两个问题：
 *  - 某个运行时能不能当 Router（准入，fail-closed）
 *  - 某个工具名在 Router 里该不该可用
 */

export const ROUTER_ROLE = "router";
export const ROUTER_SESSION_ID = "mo-router";
/** Pi TUI 标题栏显示的名字；MO_ROUTER_NAME 可覆盖 */
export const ROUTER_SESSION_NAME = process.env.MO_ROUTER_NAME || "指挥台";

/** Router 只做分派，深度思考是浪费：默认 low，MO_ROUTER_THINKING 可改 */
export const ROUTER_DEFAULT_THINKING = "low";
export const ROUTER_AGENT_LABEL = "指挥台";

/** 只读工具：由运行时提供。Router 需要能自己搜代码，否则分派质量会下降。 */
export const ROUTER_READ_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);

/** mo 的工具：由 MCP 提供，是所有写能力的唯一入口 */
export const ROUTER_MCP_PATTERN = "mcp__mo__*";

/** 组装给运行时的 `--tools` 值，顺序固定，测试会断言 */
export const ROUTER_TOOL_SPEC = Object.freeze([...ROUTER_READ_TOOLS, ROUTER_MCP_PATTERN].join(","));

/** 永远不给 Router 的工具：有了它们 Router 会自己上手干，而不是派单 */
export const ROUTER_FORBIDDEN_TOOLS = Object.freeze(["bash", "edit", "write", "powershell"]);

/** 运行时能提供的工具面粒度 */
export const TOOL_RESTRICTION = Object.freeze({
  ALLOWLIST: "allowlist",
  PRESET: "preset",
  NONE: "none",
});

export const ROUTER_ERROR = Object.freeze({
  NOT_ONBOARDED: "E_ROUTER_NOT_ONBOARDED",
  NO_CREDENTIAL: "E_ROUTER_NO_CREDENTIAL",
  RUNTIME_MISSING: "E_ROUTER_RUNTIME_MISSING",
  RUNTIME_UNSUPPORTED: "E_ROUTER_RUNTIME_UNSUPPORTED",
  ALREADY_RUNNING: "E_ROUTER_ALREADY_RUNNING",
  START_FAILED: "E_ROUTER_START_FAILED",
  UNHEALTHY: "E_ROUTER_UNHEALTHY",
  SESSION_MISSING: "E_ROUTER_SESSION_MISSING",
});

const MCP_PREFIX = ROUTER_MCP_PATTERN.slice(0, -1); // "mcp__mo__"

/**
 * 运行时准入（fail-closed）。
 * @param {{toolRestriction?: string}} capabilities
 * @returns {{ok: boolean, level: string, code?: string, reason?: string, note?: string}}
 */
export function admitRuntime(capabilities) {
  if (!capabilities || typeof capabilities !== "object") {
    return {
      ok: false,
      level: TOOL_RESTRICTION.NONE,
      code: ROUTER_ERROR.RUNTIME_UNSUPPORTED,
      reason: "运行时未声明能力（capabilities.toolRestriction）",
    };
  }

  const level = capabilities.toolRestriction;
  if (level === TOOL_RESTRICTION.ALLOWLIST) {
    return { ok: true, level };
  }
  if (level === TOOL_RESTRICTION.PRESET) {
    return { ok: true, level, note: "工具面为预设粒度，无法按名字精确白名单" };
  }
  return {
    ok: false,
    level: TOOL_RESTRICTION.NONE,
    code: ROUTER_ERROR.RUNTIME_UNSUPPORTED,
    reason: "运行时无法限制工具面（toolRestriction=" + String(level) + "），拒绝作为 Router 启动",
  };
}

/** Router 视角下这个工具名是否可用。白名单之外一律 false，不做后缀猜测。 */
export function isRouterToolAllowed(name) {
  const value = String(name == null ? "" : name).trim();
  if (!value) return false;
  if (ROUTER_READ_TOOLS.includes(value)) return true;
  return value.startsWith(MCP_PREFIX) && value.length > MCP_PREFIX.length;
}

/**
 * 校验一份工具面声明是否只含"只读 + mo 的 MCP"。
 * 拒绝通配 "*"：它会把一切放回来，是这套设计最容易写错的地方。
 * @returns {{ok: boolean, reason?: string, offending?: string}}
 */
export function validateToolSpec(toolSpec) {
  const items = String(toolSpec || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) return { ok: false, reason: "工具面为空" };
  for (const item of items) {
    if (item === "*" || item.endsWith("*") && item !== ROUTER_MCP_PATTERN) {
      return { ok: false, reason: "通配符只允许 " + ROUTER_MCP_PATTERN + "，收到 " + item, offending: item };
    }
    if (ROUTER_FORBIDDEN_TOOLS.includes(item)) {
      return { ok: false, reason: "出现禁用工具：" + item, offending: item };
    }
    if (isRouterToolAllowed(item)) continue;
    if (item === ROUTER_MCP_PATTERN) continue;
    return { ok: false, reason: "工具不在 Router 白名单内：" + item, offending: item };
  }
  return { ok: true };
}

/** 防御性检查：工具面里一旦出现禁用工具就立刻暴露（配置写错比运行出错更好抓） */
export function findForbiddenTool(toolSpec) {
  const items = String(toolSpec || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.find((item) => ROUTER_FORBIDDEN_TOOLS.includes(item)) || null;
}
