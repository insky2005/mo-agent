import test from "node:test";
import assert from "node:assert/strict";
import { insideProject, entryAdvice } from "./commands/doctor.mjs";

const projects = [
  { id: "p1", paths: ["/Users/me/code/app"] },
  { id: "p2", paths: ["/Users/me/code/lib", "/Users/me/work/lib"] },
];

test("项目根目录算在项目里", () => {
  assert.equal(insideProject("/Users/me/code/app", projects), true);
  assert.equal(insideProject("/Users/me/work/lib", projects), true);
});

test("子目录也算在项目里", () => {
  assert.equal(insideProject("/Users/me/code/app/src/deep", projects), true);
});

test("只是前缀相同但不在项目里", () => {
  assert.equal(insideProject("/Users/me/code/apple", projects), false);
  assert.equal(insideProject("/Users/me", projects), false);
});

test("没有登记任何项目", () => {
  assert.equal(insideProject("/Users/me/code/app", []), false);
  assert.equal(insideProject("/Users/me/code/app", null), false);
});

test("建议入口：装了指挥台就推指挥台", () => {
  const advice = entryAdvice({ skillInstalled: true, routerReady: true, hasTasks: true });
  assert.equal(advice.entry, "指挥台");
  assert.match(advice.next, /mo router start/);
});

test("建议入口：没指挥台但装了技能 → 外部 Agent", () => {
  const advice = entryAdvice({ skillInstalled: true, routerReady: false, hasTasks: false });
  assert.equal(advice.entry, "外部 Agent");
  assert.match(advice.next, /任务卡/);
});

test("建议入口：建过卡就是 CLI 用户", () => {
  const advice = entryAdvice({ skillInstalled: false, routerReady: false, hasTasks: true });
  assert.equal(advice.entry, "CLI");
  assert.match(advice.next, /mo task create/);
});

test("建议入口：全新用户三选一，并推荐指挥台", () => {
  const advice = entryAdvice({});
  assert.equal(advice.entry, "还没选");
  assert.match(advice.next, /推荐/);
  assert.match(advice.next, /mo router start/);
});
