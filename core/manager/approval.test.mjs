import test from "node:test";
import assert from "node:assert/strict";
import { cardDigest, decide, isExpired, isStale, makeRequest, parseApprovalAnswer } from "./approval.mjs";

const card = (over = {}) => ({
  meta: { id: "t_1", project: "p_1", title: "加筛选", verify: [{ run: "true" }], status: "draft", updated: "2026-01-01", ...over },
  body: "## 交付物\n\n- 有筛选栏\n",
});

test("cardDigest 忽略状态与时间，只看内容", () => {
  const a = cardDigest(card());
  const b = cardDigest(card({ status: "confirmed", updated: "2026-02-02" }));
  assert.equal(a, b);
});

test("cardDigest 内容变了就变", () => {
  const base = cardDigest(card());
  assert.notEqual(base, cardDigest({ ...card(), body: "## 交付物\n\n- 没有筛选栏\n" }));
  assert.notEqual(base, cardDigest(card({ title: "别的标题" })));
  assert.notEqual(base, cardDigest(card({ verify: [{ run: "false" }] })));
});

test("cardDigest 与键顺序无关", () => {
  const one = cardDigest({ meta: { project: "p", title: "t" }, body: "b" });
  const two = cardDigest({ body: "b", meta: { title: "t", project: "p" } });
  assert.equal(one, two);
});

test("makeRequest 带过期时间且默认 pending", () => {
  const request = makeRequest({ id: "a_1", taskId: "t_1", digest: "x", at: "2026-01-01T00:00:00.000Z", ttlMs: 1000 });
  assert.equal(request.status, "pending");
  assert.equal(request.expiresAt, "2026-01-01T00:00:01.000Z");
  assert.equal(request.kind, "task.confirm");
});

test("isExpired 只对 pending 生效", () => {
  const request = makeRequest({ id: "a_1", taskId: "t_1", digest: "x", at: "2026-01-01T00:00:00.000Z", ttlMs: 1 });
  assert.equal(isExpired(request, new Date("2026-01-01T00:00:01.000Z").getTime()), true);
  assert.equal(isExpired({ ...request, status: "approved" }, Date.now()), false);
});

test("decide 拒绝未知结果", () => {
  const request = makeRequest({ id: "a_1", taskId: "t_1", digest: "x" });
  assert.throws(() => decide(request, { status: "whatever" }), /未知的批准结果/);
  assert.equal(decide(request, { status: "approved", channel: "terminal" }).decidedBy.channel, "terminal");
});

test("isStale 比对指纹", () => {
  const request = makeRequest({ id: "a_1", taskId: "t_1", digest: "abc" });
  assert.equal(isStale(request, "abc"), false);
  assert.equal(isStale(request, "def"), true);
});
test("parseApprovalAnswer：y/n/回车三种语义", () => {
  for (const value of ["y", "Y", " yes ", "是", "批准", "允许"]) assert.equal(parseApprovalAnswer(value), "yes", value);
  for (const value of ["n", "No", "否", "拒绝"]) assert.equal(parseApprovalAnswer(value), "no", value);
  for (const value of ["", "  ", "随便", undefined, null, "maybe"]) {
    assert.equal(parseApprovalAnswer(value), "cancel", String(value));
  }
});
