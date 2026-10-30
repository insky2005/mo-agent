import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIMEOUT_MS, findOverdue, parseTimeoutMs } from "./watch.mjs";

const card = (over = {}) => ({
  meta: { id: "t_1", status: "running", updated: "2026-01-01T00:00:00.000Z", timeout: "45m", ...over },
});

test("parseTimeoutMs 支持 ms/s/m/h，兜底默认值", () => {
  assert.equal(parseTimeoutMs("90s"), 90 * 1000);
  assert.equal(parseTimeoutMs("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseTimeoutMs("45m"), 45 * 60 * 1000);
  assert.equal(parseTimeoutMs("1000ms"), 1000);
  assert.equal(parseTimeoutMs("乱写"), DEFAULT_TIMEOUT_MS);
  assert.equal(parseTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
});

test("findOverdue 只挑 running/dispatched 且超过各自 timeout 的", () => {
  const now = Date.parse("2026-01-01T02:00:00.000Z"); // 2 小时后
  const cards = [
    card({ id: "old", updated: "2026-01-01T00:00:00.000Z", timeout: "45m" }),   // 超时
    card({ id: "fresh", updated: "2026-01-01T01:50:00.000Z", timeout: "45m" }), // 10 分钟，未超
    card({ id: "long", updated: "2026-01-01T00:00:00.000Z", timeout: "3h" }),   // 2h < 3h，未超
    card({ id: "done", status: "done", updated: "2026-01-01T00:00:00.000Z" }),  // 终态不碰
    card({ id: "broken", updated: "not-a-date" }),
  ];

  const overdue = findOverdue(cards, { now });
  assert.deepEqual(overdue.map((item) => item.card.meta.id), ["old"]);
  assert.equal(overdue[0].timeoutMs, 45 * 60 * 1000);
  assert.equal(overdue[0].elapsedMs, 2 * 60 * 60 * 1000);
});

test("findOverdue 支持自定义 timeoutFor", () => {
  const now = Date.parse("2026-01-01T00:20:00.000Z");
  const cards = [card({ id: "x", updated: "2026-01-01T00:00:00.000Z" })];
  assert.equal(findOverdue(cards, { now, timeoutFor: () => 30 * 60 * 1000 }).length, 0);
  assert.equal(findOverdue(cards, { now, timeoutFor: () => 10 * 60 * 1000 }).length, 1);
});
