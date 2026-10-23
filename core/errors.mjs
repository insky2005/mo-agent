/**
 * 领域错误：带稳定错误码，CLI / host / 测试共用。
 * 码表见 docs/spec/workbench-flow.md §8。
 */
export class MoError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MoError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details) {
  throw new MoError(code, message, details);
}

export function isMoError(error) {
  return error instanceof MoError;
}
