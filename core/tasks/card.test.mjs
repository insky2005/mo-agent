import test from "node:test";
import assert from "node:assert/strict";
import { parseCard, renderCard, validateCard, cardSections, verifyItems } from "./card.mjs";

const sample = [
  "---",
  "id: t_01ABC",
  "project: p_01XYZ",
  "title: 加筛选",
  "status: draft",
  "created: 2026-10-23T10:00:00.000Z",
  "assignee: auto",
  "workdir: .",
  "verify:",
  "  - run: npm test",
  "  - check: 文件存在",
  "  - human: 视觉确认",
  "receipt: .mo-agent/receipts/t_01ABC.json",
  "timeout: 45m",
  "budget:",
  "  runtime: 45m",
  "  tokens: 200000",
  "---",
  "",
  "## 背景",
  "",
  "想加个筛选。",
  "",
  "## 交付物",
  "",
  "- app/web/tasks.html 有筛选栏",
  "",
].join("\n");

test("parseCard 读出 frontmatter 与正文", () => {
  const { meta, body } = parseCard(sample);
  assert.equal(meta.id, "t_01ABC");
  assert.equal(meta.title, "加筛选");
  assert.equal(meta.timeout, "45m");
  assert.equal(meta.verify.length, 3);
  assert.equal(meta.verify[0].run, "npm test");
  assert.equal(meta.verify[1].check, "文件存在");
  assert.equal(meta.budget.tokens, 200000);
  assert.match(body, /## 背景/);
});

test("renderCard → parseCard 往返不丢信息", () => {
  const first = parseCard(sample);
  const rendered = renderCard(first);
  const second = parseCard(rendered);
  assert.deepEqual(second.meta, first.meta);
  assert.equal(second.body.trim(), first.body.trim());
});

test("值里带冒号会被安全引用", () => {
  const meta = { id: "t_1", project: "p_1", title: "a: b", status: "draft", verify: [{ check: "x: y" }] };
  const round = parseCard(renderCard({ meta, body: "" }));
  assert.equal(round.meta.title, "a: b");
  assert.equal(round.meta.verify[0].check, "x: y");
});

test("validateCard 拦住缺字段与非法状态", () => {
  assert.throws(() => validateCard({ id: "t", project: "p", title: "x", status: "nope" }), /status 非法/);
  assert.throws(() => validateCard({ id: "t", title: "x", status: "draft" }), /缺少字段：project/);
  assert.equal(validateCard({ id: "t", project: "p", title: "x", status: "draft", verify: [] }), true);
});

test("cardSections 按二级标题切分", () => {
  const { body } = parseCard(sample);
  const sections = cardSections(body);
  assert.equal(sections["背景"], "想加个筛选。");
  assert.match(sections["交付物"], /筛选栏/);
});

test("verifyItems 兼容空值", () => {
  assert.deepEqual(verifyItems({}), []);
  assert.equal(verifyItems({ verify: [{ run: "x" }] }).length, 1);
});

test("缺失 frontmatter 报 E_CARD_INVALID", () => {
  assert.throws(() => parseCard("# 没有 frontmatter"), (error) => error.code === "E_CARD_INVALID");
});
