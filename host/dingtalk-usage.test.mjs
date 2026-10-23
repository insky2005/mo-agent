import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUsageStore } from "./dingtalk-usage.mjs";

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-usage-"));
  return path.join(dir, name || "usage.json");
}

function oct(day) {
  return Date.UTC(2026, 9, day, 4, 0, 0); // 2026-10-01 12:00 +08:00
}

test("local 与 billable 分开计数，billable 只由 recordBillable 累加", () => {
  const file = tmpFile();
  let at = oct(1);
  const store = createUsageStore({ file, now: () => at, saveDebounceMs: 100000 });

  store.record({ api: "robot/oToMessages/batchSend", category: "stream", ok: true, ms: 12 });
  store.recordBillable({ kind: "approval", direction: "out" });
  store.record({ api: "stream.event", category: "stream", ok: true, billable: true, kind: "event", direction: "in" });

  const snap = store.snapshot();
  assert.equal(snap.local.total, 2);
  assert.equal(snap.local.ok, 2);
  assert.equal(snap.local.byApi["robot/oToMessages/batchSend"], 1);
  assert.equal(snap.billable.total, 2);
  assert.equal(snap.billable.byDirection.out, 1);
  assert.equal(snap.billable.byDirection.in, 1);
  store.flush();
});

test("失败与重试计入 local，不计 billable", () => {
  const file = tmpFile();
  const store = createUsageStore({ file, now: () => oct(1), saveDebounceMs: 100000 });
  store.record({ api: "robot/oToMessages/batchSend", ok: false, retry: true });
  const snap = store.snapshot();
  assert.equal(snap.local.total, 1);
  assert.equal(snap.local.fail, 1);
  assert.equal(snap.local.retries, 1);
  assert.equal(snap.billable.total, 0);
  assert.equal(snap.billable.failures, 0);
  store.flush();
});

test("预算闸门：80% 可发，100% 只留确认类，120% 全停", () => {
  const file = tmpFile();
  const store = createUsageStore({
    file, now: () => oct(1), monthlyLimit: 10, warnAt: 0.8, confirmOnlyAt: 1, hardStopAt: 1.2, saveDebounceMs: 100000,
  });
  for (let i = 0; i < 8; i += 1) store.recordBillable({ kind: "approval", direction: "out" });
  assert.equal(store.canSend({ requiresAction: false }).allow, true);

  for (let i = 0; i < 2; i += 1) store.recordBillable({ kind: "approval", direction: "out" });
  assert.equal(store.canSend({ requiresAction: false }).allow, false);
  assert.equal(store.canSend({ requiresAction: false }).reason, "confirm-only");
  assert.equal(store.canSend({ requiresAction: true }).allow, true);

  for (let i = 0; i < 2; i += 1) store.recordBillable({ kind: "approval", direction: "out" });
  assert.equal(store.canSend({ requiresAction: true }).allow, false);
  assert.equal(store.canSend({ requiresAction: true }).reason, "hard-stop");
  store.flush();
});

test("配额错误标记后停止出站，清除后恢复", () => {
  const file = tmpFile();
  const store = createUsageStore({ file, now: () => oct(1), saveDebounceMs: 100000 });
  store.markQuotaExhausted("send.too.fast");
  assert.equal(store.canSend({ requiresAction: true }).reason, "quota-exhausted");
  store.clearQuotaExhausted();
  assert.equal(store.canSend({ requiresAction: true }).allow, true);
  store.flush();
});

test("落盘后可恢复，跨月归档并归零", () => {
  const file = tmpFile();
  let at = oct(31);
  const store = createUsageStore({ file, now: () => at, saveDebounceMs: 100000 });
  store.record({ api: "stream.event", ok: true, billable: true, kind: "event", direction: "in" });
  store.flush();

  const again = createUsageStore({ file, now: () => at, saveDebounceMs: 100000 });
  assert.equal(again.snapshot().local.total, 1);
  again.flush();

  at = Date.UTC(2026, 10, 1, 4, 0, 0); // 2026-11-01 12:00 +08:00
  const next = createUsageStore({ file, now: () => at, saveDebounceMs: 100000 });
  assert.equal(next.snapshot().month, "2026-11");
  assert.equal(next.snapshot().local.total, 0);
  assert.ok(fs.existsSync(path.join(path.dirname(file), "usage-2026-10.json")));
  next.flush();
});

test("recent 环形缓冲不超过上限", () => {
  const file = tmpFile();
  const store = createUsageStore({ file, now: () => oct(1), recentLimit: 3, saveDebounceMs: 100000 });
  for (let i = 0; i < 5; i += 1) store.record({ api: "x" + i });
  assert.equal(store.snapshot().local.recent.length, 3);
  assert.equal(store.snapshot().local.recent[0].api, "x4");
  store.flush();
});
