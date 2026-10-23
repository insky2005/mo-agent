import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { skillCommand } from "./commands/skill.mjs";
import { SKILL_MD, SKILL_NAME } from "./lib/skill-content.mjs";

function run(args, options = {}) {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return { code: skillCommand({ cwd: process.cwd() }, { positional: args, options }), out: lines.join("") };
  } finally {
    process.stdout.write = original;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-skill-"));
}

test("安装到指定目录并写入 SKILL.md", () => {
  const dir = tmpDir();
  const result = run(["install"], { target: [dir] });
  assert.equal(result.code, 0);
  const file = path.join(dir, SKILL_NAME, "SKILL.md");
  assert.equal(fs.readFileSync(file, "utf8"), SKILL_MD);
});

test("重复安装是幂等的", () => {
  const dir = tmpDir();
  run(["install"], { target: [dir] });
  run(["install"], { target: [dir] });
  const files = fs.readdirSync(path.join(dir, SKILL_NAME));
  assert.deepEqual(files, ["SKILL.md"]);
});

test("卸载只删自己的目录", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "other-skill"), { recursive: true });
  run(["install"], { target: [dir] });
  run(["uninstall"], { target: [dir] });
  assert.equal(fs.existsSync(path.join(dir, SKILL_NAME)), false);
  assert.equal(fs.existsSync(path.join(dir, "other-skill")), true);
});

test("未知目标报 E_USAGE", () => {
  assert.throws(
    () => run(["install"], { target: ["not-a-target"] }),
    (error) => error.code === "E_USAGE",
  );
});

test("内置内容包含技能名与铁律", () => {
  assert.match(SKILL_MD, /^---\nname: mo/);
  assert.match(SKILL_MD, /没确认不派单/);
});
test("默认目标包含 ~/.agents，且只加已存在的 Agent 目录", () => {
  const fakeHome = tmpDir();
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  const before = { home: process.env.HOME, dsh: process.env.DSH_HOME };
  process.env.HOME = fakeHome;
  delete process.env.DSH_HOME;
  try {
    const result = run(["list"]);
    assert.match(result.out, /agents/);
    assert.match(result.out, /\.claude/);
    assert.doesNotMatch(result.out, /\.dsh/);
  } finally {
    process.env.HOME = before.home;
    if (before.dsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = before.dsh;
  }
});
