import { MoError } from "../../core/errors.mjs";
import { one } from "./args.mjs";

/**
 * 谁发起的这次调用。优先级：--actor > MO_ACTOR > TTY 判断。
 * 约定：human / agent:<名字> / cli（非交互脚本）。
 */
export function resolveActor(options = {}, env = process.env, isTTY = process.stdout.isTTY) {
  const explicit = one(options, "actor", "");
  if (explicit) return String(explicit).trim();

  const fromEnv = env.MO_ACTOR ? String(env.MO_ACTOR).trim() : "";
  if (fromEnv) return fromEnv;

  return isTTY ? "human" : "cli";
}

export function isAgentActor(actor) {
  return /^agent[:/]/i.test(String(actor));
}

/** 确认这类动作只有人能拍板：Agent 自报身份时直接拒绝。 */
export function assertHuman(actor, action) {
  if (!isAgentActor(actor)) return;
  throw new MoError("E_HUMAN_ONLY", action + "必须由人执行，Agent 不能代劳", {
    hint: "让用户自己运行这条命令",
  });
}
