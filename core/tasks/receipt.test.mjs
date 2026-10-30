import test from "node:test";
import assert from "node:assert/strict";
import { validateReceipt } from "./receipt.mjs";

test("合法回执通过", () => {
  const result = validateReceipt({ taskId: "t_1", status: "done", verify: [{ cmd: "npm test", exit: 0 }] }, { taskId: "t_1" });
  assert.equal(result.ok, true);
});

test("taskId 不匹配要报错", () => {
  const result = validateReceipt({ taskId: "t_2", status: "done", verify: [{ exit: 0 }] }, { taskId: "t_1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /taskId 不匹配/);
});

test("done 但没有验收证据视为非法", () => {
  const result = validateReceipt({ taskId: "t_1", status: "done" }, { taskId: "t_1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /verify 为空/);
});

test("done 但 verify 有失败项视为非法", () => {
  const result = validateReceipt({ taskId: "t_1", status: "done", verify: [{ exit: 0 }, { exit: 1 }] }, { taskId: "t_1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /失败项/);
});

test("非 done 允许没有 verify", () => {
  const result = validateReceipt({ taskId: "t_1", status: "blocked" }, { taskId: "t_1" });
  assert.equal(result.ok, true);
});

test("非法 status 报错", () => {
  const result = validateReceipt({ taskId: "t_1", status: "finished" }, { taskId: "t_1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /status 非法/);
});

test("数组字段会被补全", () => {
  const result = validateReceipt({ taskId: "t_1", status: "partial" }, { taskId: "t_1" });
  assert.deepEqual(result.receipt.artifacts, []);
  assert.deepEqual(result.receipt.pitfalls, []);
});
