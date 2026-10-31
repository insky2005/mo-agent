import test from "node:test";
import assert from "node:assert/strict";
import { updatePackageJson, updateLock, updateVersionModule } from "./bump-version.mjs";

test("package.json 只换 version，其余保持", () => {
  const before = JSON.stringify({ name: "mo-agent", version: "0.2.0", scripts: { a: "b" } }, null, 2) + "\n";
  const after = updatePackageJson(before, "0.2.1");
  const pkg = JSON.parse(after);
  assert.equal(pkg.version, "0.2.1");
  assert.equal(pkg.name, "mo-agent");
  assert.deepEqual(pkg.scripts, { a: "b" });
});

test("package-lock 同时改顶层与 packages['']", () => {
  const before = JSON.stringify({ version: "0.2.0", packages: { "": { version: "0.2.0", name: "mo-agent" } } }, null, 2);
  const lock = JSON.parse(updateLock(before, "0.3.0"));
  assert.equal(lock.version, "0.3.0");
  assert.equal(lock.packages[""].version, "0.3.0");
  assert.equal(lock.packages[""].name, "mo-agent");
});

test("version.mjs 替换常量", () => {
  const out = updateVersionModule('export const VERSION = "0.2.0";\n', "0.2.1");
  assert.equal(out, 'export const VERSION = "0.2.1";\n');
});

test("version.mjs 结构不对时报错", () => {
  assert.throws(() => updateVersionModule("const x = 1;\n", "0.2.1"), /找不到 VERSION/);
});
