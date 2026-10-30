import test from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN, FORMATS, RULES, TOOLS, render } from "./contract.mjs";

const AGENT_NAMES = /claude|codex|qoder|workbuddy|\bdsh\b|\bpi\b|qwen/i;

test("所有工具都出现在 prompt 里", () => {
  const prompt = render("prompt");
  for (const tool of TOOLS) {
    assert.ok(prompt.includes(tool.name), "契约漏了工具 " + tool.name);
  }
});

test("禁止动作不出现在工具表里", () => {
  const names = TOOLS.map((tool) => tool.name);
  for (const item of FORBIDDEN) {
    assert.ok(!names.includes(item.action), "禁止动作被暴露了：" + item.action);
  }
});

test("文案里不写死具体 Agent 名字（防腐化）", () => {
  for (const format of FORMATS) {
    const text = render(format);
    assert.doesNotMatch(text, AGENT_NAMES, format + " 里写死了 Agent 名字");
  }
});

test("边界段出现在每一份行为渲染里", () => {
  for (const format of ["skill", "prompt", "mo-doc"]) {
    assert.match(render(format), /## 不能做的|批准\/拒绝任务卡/, format + " 缺少边界说明");
  }
  const skill = render("skill");
  const prompt = render("prompt");
  for (const item of FORBIDDEN) {
    assert.ok(prompt.includes(item.cli), "prompt 缺少禁止项 " + item.cli);
    assert.ok(skill.includes(item.cli), "skill 缺少禁止项 " + item.cli);
  }
  assert.equal((skill.match(/## 不能做的/g) || []).length, 1, "skill 里边界段重复了");
});

test("skill 与 prompt 的行为段逐字相同（只允许包装不同）", () => {
  const marker = "## 不能做的";
  const skill = render("skill");
  const prompt = render("prompt");
  const skillTail = skill.slice(skill.indexOf(marker));
  const promptTail = prompt.slice(prompt.indexOf(marker));
  assert.equal(skillTail, promptTail);
});

test("prompt 明确 confirm 只是请求、批准由人做", () => {
  const prompt = render("prompt");
  assert.match(prompt, /task_confirm/);
  assert.match(prompt, /批准/);
  assert.match(prompt, /mo task approve/);
});

test("skill 有 frontmatter、铁律、常见失败", () => {
  const skill = render("skill");
  assert.match(skill, /^---\nname: mo\n/);
  assert.match(skill, /## 铁律/);
  assert.match(skill, /## 常见失败/);
  for (const rule of RULES) {
    assert.ok(skill.includes(rule.split("：")[0].slice(0, 6)), "技能缺少铁律：" + rule.slice(0, 12));
  }
});

test("agent-block 短，且带批准边界", () => {
  const block = render("agent-block");
  assert.ok(block.split("\n").length < 25, "AGENTS.md 内联块太长");
  assert.match(block, /mo task confirm/);
  assert.match(block, /批准由人做/);
});

test("pointer 只有块头，MO.md 中等长度", () => {
  assert.ok(render("pointer").split("\n").length < 10);
  const doc = render("mo-doc");
  assert.match(doc, /mo task requests/);
  assert.match(doc, /missing_receipt/);
  assert.ok(doc.split("\n").length < render("skill").split("\n").length);
});

test("所有格式都非空且以换行结尾", () => {
  for (const format of FORMATS) {
    const text = render(format);
    assert.ok(text.length > 40, format + " 太短");
    assert.ok(text.endsWith("\n"), format + " 结尾没有换行");
  }
});

test("渲染结果里的代码围栏完整，没有占位符残留", () => {
  const fence = String.fromCharCode(96).repeat(3);
  for (const format of FORMATS) {
    const text = render(format);
    const fences = text.split(fence).length - 1;
    assert.equal(fences % 2, 0, format + " 的代码围栏不成对");
    assert.doesNotMatch(text, /%%BT%%|%%FENCE%%/, format + " 残留占位符");
    assert.doesNotMatch(text, new RegExp(String.fromCharCode(96) + "BT" + String.fromCharCode(96)), format + " 围栏被转义坏了");
  }
  assert.ok(render("skill").includes(fence + "bash"), "skill 里应该有 bash 代码块");
});

test("未知格式直接报错", () => {
  assert.throws(() => render("nope"), /未知格式/);
});
