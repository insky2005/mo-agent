import test from "node:test";
import assert from "node:assert/strict";
import { insideProject } from "./commands/doctor.mjs";

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
