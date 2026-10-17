import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPushTokenStore } from "./push-tokens.mjs";

test("push token 落盘并可在重启后恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-push-"));
  const file = path.join(dir, "push-tokens.json");
  const log = { warn() {} };
  const a = createPushTokenStore({ file, log });
  assert.equal(a.add("t1"), 1);
  a.add("t2");
  a.add("t1");
  assert.deepEqual(a.list().sort(), ["t1", "t2"]);
  const b = createPushTokenStore({ file, log });
  assert.deepEqual(b.list().sort(), ["t1", "t2"]);
  b.remove("t1");
  const c = createPushTokenStore({ file, log });
  assert.deepEqual(c.list(), ["t2"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
