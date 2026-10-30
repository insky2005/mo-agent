import test from "node:test";
import assert from "node:assert/strict";
import { parseKnowledgeFile, entryId } from "./entry.mjs";
import { tokenize, scoreEntry, recall, formatKnowledgeBlock } from "./recall.mjs";

const PREFERENCES = [
  "---",
  "title: 偏好",
  "trigger: 派单, 执行",
  "---",
  "",
  "## 先问再做",
  "",
  "- trigger: 修改, 删除",
  "- tags: 安全",
  "",
  "改动别人的文件前先说明改哪里。",
  "",
  "## 结论先行",
  "",
  "回答第一句给结论，再展开。",
  "",
].join("\n");

test("按 ## 切条目，抽 trigger / tags", () => {
  const entries = parseKnowledgeFile({ scope: "preferences", name: "preferences.md", text: PREFERENCES });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, "先问再做");
  assert.match(entries[0].body, /改动别人的文件/);
  assert.doesNotMatch(entries[0].body, /trigger:/);
  assert.deepEqual(entries[0].trigger, ["修改", "删除", "派单", "执行"]);
  assert.deepEqual(entries[0].tags, ["安全"]);
  assert.equal(entries[1].title, "结论先行");
  assert.deepEqual(entries[1].trigger, ["派单", "执行"]);
  assert.match(entries[0].id, /^preferences:preferences#/);
});

test("没有 ## 时整个文件算一条，标题取 # 或文件名", () => {
  const text = "# 避坑\n\n收据里 status=done 不等于验收通过。\n";
  const entries = parseKnowledgeFile({ scope: "pitfalls", name: "receipt.md", text });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "避坑");
  assert.match(entries[0].body, /status=done/);
});

test("代码块里的 ## 不当标题", () => {
  const text = ["## 跑测试", "", "\`\`\`bash", "## 这不是标题", "npm test", "\`\`\`", ""].join("\n");
  const entries = parseKnowledgeFile({ scope: "pitfalls", name: "test.md", text });
  assert.equal(entries.length, 1);
  assert.match(entries[0].body, /## 这不是标题/);
});

test("同标题的条目 id 不重复", () => {
  const text = "## 同名\n\na\n\n## 同名\n\nb\n";
  const entries = parseKnowledgeFile({ scope: "decisions", name: "dup.md", text });
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("tokenize：英文按词、中文按二元组", () => {
  const tokens = tokenize("派单任务 tasks 面板");
  assert.ok(tokens.includes("tasks"));
  assert.ok(tokens.includes("派单"));
  assert.ok(tokens.includes("任务"));
});

test("recall 按命中位置打分并排序", () => {
  const entries = [
    { id: "a", scope: "pitfalls", name: "x.md", title: "回执超时", body: "超时后不要重试超过一次。", trigger: [], tags: [] },
    { id: "b", scope: "preferences", name: "y.md", title: "写作", body: "不要在派单前删档。", trigger: [], tags: [] },
    { id: "c", scope: "decisions", name: "z.md", title: "无关", body: "颜色。", trigger: [], tags: [] },
  ];
  const result = recall(entries, { query: "回执超时怎么办" });
  assert.equal(result.matched[0].id, "a");
  assert.ok(result.matched.every((entry) => entry.id !== "c"));
});

test("scope 过滤与 limit", () => {
  const entries = [
    { id: "a", scope: "preferences", name: "p.md", title: "派单", body: "x", trigger: [], tags: [] },
    { id: "b", scope: "pitfalls", name: "q.md", title: "派单", body: "y", trigger: [], tags: [] },
  ];
  const result = recall(entries, { query: "派单", scopes: ["pitfalls"] });
  assert.deepEqual(result.matched.map((entry) => entry.id), ["b"]);
  assert.equal(recall(entries, { query: "派单", limit: 1 }).matched.length, 1);
});

test("空 query 不返回候选", () => {
  const entries = [{ id: "a", scope: "preferences", name: "p.md", title: "派单", body: "x", trigger: [], tags: [] }];
  assert.deepEqual(recall(entries, { query: "  " }).matched, []);
});

test("formatKnowledgeBlock 按 scope 分组、截断正文", () => {
  const matched = [
    { id: "preferences:p#a", scope: "preferences", title: "先问", body: "先问再做。" },
    { id: "pitfalls:q#b", scope: "pitfalls", title: "超时", body: "x".repeat(400) },
  ];
  const block = formatKnowledgeBlock(matched, { maxBody: 10 });
  assert.match(block, /### 偏好/);
  assert.match(block, /### 避坑/);
  assert.match(block, /…/);
  assert.equal(formatKnowledgeBlock([]), "");
});

test("scoreEntry 对 title / trigger 加权更高", () => {
  const tokens = tokenize("派单");
  const titleHit = scoreEntry({ title: "派单", body: "", trigger: [], tags: [] }, tokens);
  const bodyHit = scoreEntry({ title: "无关", body: "派单", trigger: [], tags: [] }, tokens);
  assert.ok(titleHit.score > bodyHit.score);
});

test("entryId 稳定且可读", () => {
  assert.equal(entryId("pitfalls", "a/b.md", "标题"), "pitfalls:b#标题");
  assert.equal(entryId("pitfalls", "a/b.md", "标题"), entryId("pitfalls", "a/b.md", "标题"));
  assert.equal(entryId("pitfalls", "a/b.md", "Timeout"), "pitfalls:b#timeout");
});
