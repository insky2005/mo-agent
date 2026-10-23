/**
 * 回执校验：决定"这次算不算完成"的唯一依据。
 * 见 docs/spec/workbench-flow.md §7.3、B7。
 */
import { MoError } from "../errors.mjs";

export const RECEIPT_STATUS = ["done", "partial", "failed", "blocked"];

export function normalizeReceipt(receipt) {
  const value = receipt && typeof receipt === "object" ? receipt : {};
  return {
    taskId: value.taskId,
    status: value.status,
    summary: typeof value.summary === "string" ? value.summary : "",
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    verify: Array.isArray(value.verify) ? value.verify : [],
    deviations: Array.isArray(value.deviations) ? value.deviations : [],
    pitfalls: Array.isArray(value.pitfalls) ? value.pitfalls : [],
    needs: Array.isArray(value.needs) ? value.needs : [],
  };
}

/**
 * @returns {{ok: boolean, errors: string[], receipt: object}}
 */
export function validateReceipt(receipt, options = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, errors: ["回执必须是 JSON 对象"], receipt: normalizeReceipt(null) };
  }
  const normalized = normalizeReceipt(receipt);

  if (!normalized.taskId) {
    errors.push("缺少 taskId");
  } else if (options.taskId && normalized.taskId !== options.taskId) {
    errors.push(`taskId 不匹配：回执 ${normalized.taskId}，任务 ${options.taskId}`);
  }

  if (!RECEIPT_STATUS.includes(normalized.status)) {
    errors.push(`status 非法：${normalized.status}，允许值：${RECEIPT_STATUS.join(" / ")}`);
  }

  if (normalized.status === "done") {
    if (!normalized.verify.length) {
      errors.push("status=done 但 verify 为空（没有任何验收证据）");
    }
    const failed = normalized.verify.filter((item) => item && item.exit !== undefined && Number(item.exit) !== 0);
    if (failed.length) {
      errors.push(`status=done 但 verify 中存在失败项（${failed.length} 条）`);
    }
  }

  return { ok: errors.length === 0, errors, receipt: normalized };
}

export function assertReceipt(receipt, options = {}) {
  const result = validateReceipt(receipt, options);
  if (!result.ok) {
    throw new MoError("E_BAD_RECEIPT", result.errors.join("；"), { errors: result.errors });
  }
  return result.receipt;
}
