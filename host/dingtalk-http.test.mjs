import test from "node:test";
import assert from "node:assert/strict";
import { createDingTalkFetch, apiName } from "./dingtalk-http.mjs";

function fakeMeter() {
  const records = [];
  return { records, record(entry) { records.push(entry); } };
}

test("apiName 取路径", () => {
  assert.equal(apiName("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"), "v1.0/robot/oToMessages/batchSend");
  assert.equal(apiName("not a url"), "unknown");
});

test("成功请求记 local，时间可选注入", async () => {
  const meter = fakeMeter();
  let t = 100;
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const dingFetch = createDingTalkFetch({ fetchImpl, meter, now: () => (t += 5) });

  const res = await dingFetch("https://api.dingtalk.com/v1.0/x", {}, { api: "x", category: "stream" });
  assert.equal(res.ok, true);
  assert.equal(meter.records.length, 1);
  assert.equal(meter.records[0].api, "x");
  assert.equal(meter.records[0].ok, true);
  assert.equal(meter.records[0].category, "stream");
  assert.equal(meter.records[0].ms, 5);
});

test("失败请求记 local 并抛出", async () => {
  const meter = fakeMeter();
  const fetchImpl = async () => { throw new Error("boom"); };
  const dingFetch = createDingTalkFetch({ fetchImpl, meter, now: () => 0 });

  await assert.rejects(() => dingFetch("https://api.dingtalk.com/x", {}, { api: "x" }), /boom/);
  assert.equal(meter.records.length, 1);
  assert.equal(meter.records[0].ok, false);
  assert.equal(meter.records[0].api, "x");
});
