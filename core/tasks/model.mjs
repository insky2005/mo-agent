/**
 * 任务状态机：只描述合法迁移，不做任何 IO。
 * 见 docs/spec/workbench-flow.md §5。
 */
import { MoError } from "../errors.mjs";

export const STATES = [
  "draft",
  "confirmed",
  "dispatched",
  "running",
  "done",
  "failed",
  "blocked",
  "canceled",
  "expired",
];

export const TERMINAL_STATES = new Set(["done", "failed", "canceled", "expired"]);

const TRANSITIONS = {
  draft: ["confirmed", "canceled", "expired"],
  confirmed: ["dispatched", "canceled"],
  dispatched: ["running", "failed", "canceled"],
  running: ["done", "failed", "blocked", "canceled"],
  blocked: ["running", "done", "failed", "canceled"],
  done: [],
  failed: [],
  canceled: [],
  expired: [],
};

/** 回执声明的结果 → 任务状态 */
export const RECEIPT_TO_STATE = {
  done: "done",
  partial: "blocked",
  failed: "failed",
  blocked: "blocked",
};

export const VERIFY_RESULTS = ["unverified", "verified", "verify_failed"];

export function isState(value) {
  return STATES.includes(value);
}

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

export function assertTransition(from, to) {
  if (!isState(from)) {
    throw new MoError("E_CARD_INVALID", `未知状态：${from}`);
  }
  if (!isState(to)) {
    throw new MoError("E_TRANSITION", `未知目标状态：${to}`, { from, to });
  }
  if (!canTransition(from, to)) {
    throw new MoError("E_TRANSITION", `不允许的状态迁移：${from} → ${to}`, { from, to });
  }
  return true;
}

export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/** blocked 不是终态，但需要人／重试才能继续 */
export function needsAttention(state) {
  return state === "blocked";
}
