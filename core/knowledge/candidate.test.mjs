import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCandidate,
  validateCandidate,
  detectConflict,
  renderEntry,
  targetFileName,
} from "./candidate.mjs";

const base = () =>
  normalizeCandidate({
    scope: "pitfalls",
    title: "派单超时先看日志",
    trigger: ["派单", "超时"],
    body: "先看 mo task logs，再决定是否重试。",
  });

test("normalize：trigger 支持字符串与数组，去重去空", () => {
  const candidate = normalizeCandidate({ title: " x ", trigger: "a, b，c、a", tags: ["t1", "t1"] });
  assert.equal(candidate.scope, "pitfalls");
  assert.equal(candidate.title, "x");
  assert.deepEqual(candidate.trigger, ["a", "b", "c"]);
  assert.deepEqual(candidate.tags, ["t1"]);
});

test("validate：缺触发条件直接拒收（B10.3）", () => {
  const checked = validateCandidate(normalizeCandidate({ title: "x", body: "y" }));
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("；"), /触发条件/);
});

test("validate：scope / 标题 / 正文都要有", () => {
  const checked = validateCandidate(normalizeCandidate({ scope: "nope", title: "", trigger: ["a"], body: "" }));
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("；"), /scope/);
  assert.match(checked.errors.join("；"), /标题/);
  assert.match(checked.errors.join("；"), /正文/);
});

test("validate：合法候选通过", () => {
  assert.equal(validateCandidate(base()).ok, true);
});

test("detectConflict：同标题算冲突（B10.4）", () => {
  const entries = [{ id: "pitfalls:a#x", scope: "pitfalls", title: "派单超时先看日志", body: "旧内容", path: "/k/a.md" }];
  const conflict = detectConflict(base(), entries);
  assert.equal(conflict.kind, "same-title");
  assert.equal(conflict.entry.id, "pitfalls:a#x");
});

test("detectConflict：正文高度重合算冲突", () => {
  const candidate = normalizeCandidate({
    scope: "pitfalls",
    title: "另一种说法",
    trigger: ["x"],
    body: "先看 mo task logs，再决定是否重试。",
  });
  const entries = [
    { id: "pitfalls:b#y", scope: "pitfalls", title: "完全不同的标题", body: "先看 mo task logs，再决定是否重试。", path: "/k/b.md" },
  ];
  const conflict = detectConflict(candidate, entries);
  assert.equal(conflict.kind, "overlap");
});

test("detectConflict：跨 scope 不算冲突", () => {
  const entries = [{ id: "preferences:x#y", scope: "preferences", title: "派单超时先看日志", body: "旧内容" }];
  assert.equal(detectConflict(base(), entries), null);
});

test("detectConflict：不相关的条目不算冲突", () => {
  const entries = [{ id: "pitfalls:#z", scope: "pitfalls", title: "颜色规范", body: "主色用蓝。" }];
  assert.equal(detectConflict(base(), entries), null);
});

test("renderEntry 与知识库条目格式一致", () => {
  const text = renderEntry({ ...base(), tags: ["任务"] });
  assert.equal(
    text,
    ["## 派单超时先看日志", "", "- trigger: 派单, 超时", "- tags: 任务", "", "先看 mo task logs，再决定是否重试。", ""].join("\n"),
  );
});

test("targetFileName：偏好集中，避坑一条一个文件", () => {
  assert.equal(targetFileName({ ...base(), scope: "preferences" }), "preferences.md");
  assert.match(targetFileName(base()), /^pitfalls\/.+\.md$/);
  assert.match(targetFileName({ ...base(), scope: "decisions" }), /^decisions\/.+\.md$/);
});
