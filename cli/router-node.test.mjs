import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, parseVersion, resolveNode, satisfies } from "./lib/router-node.mjs";

test("版本解析与比较", () => {
  assert.deepEqual(parseVersion("v22.23.2"), { major: 22, minor: 23, patch: 2 });
  assert.equal(parseVersion("nope"), null);
  assert.equal(compareVersions("22.23.2", "22.19.0"), 1);
  assert.equal(compareVersions("22.19.0", "22.19.0"), 0);
  assert.equal(compareVersions("20.1.0", "22.19.0"), -1);
  assert.equal(compareVersions("bad", "1.0.0"), null);
});

test("约束只认 >= 与裸版本", () => {
  assert.equal(satisfies("22.23.2", ">=22.19.0"), true);
  assert.equal(satisfies("22.19.0", ">=22.19.0"), true);
  assert.equal(satisfies("22.18.9", ">=22.19.0"), false);
  assert.equal(satisfies("22.23.2", "22.23.2"), true);
  assert.equal(satisfies("22.23.2", "22.23.1"), false);
  assert.equal(satisfies("22.23.2", ""), true);
});

test("找不到满足要求的 Node 时给出已尝试的清单", () => {
  const result = resolveNode({ env: { MO_ROUTER_NODE: "/nonexistent/node-binary" }, required: ">=999.0.0" });
  assert.equal(result.ok, false);
  assert.equal(result.required, ">=999.0.0");
  assert.ok(Array.isArray(result.found));
});

test("能用显式指定的 Node", () => {
  const result = resolveNode({ env: { MO_ROUTER_NODE: process.execPath }, required: ">=0.0.1" });
  assert.equal(result.ok, true);
  assert.equal(result.source, "MO_ROUTER_NODE");
});
