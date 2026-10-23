import test from "node:test";
import assert from "node:assert/strict";
import { assertTransition, canTransition, isTerminal } from "./model.mjs";

test("合法迁移", () => {
  assert.equal(canTransition("draft", "confirmed"), true);
  assert.equal(canTransition("confirmed", "dispatched"), true);
  assert.equal(canTransition("dispatched", "running"), true);
  assert.equal(canTransition("running", "done"), true);
  assert.equal(canTransition("running", "blocked"), true);
  assert.equal(canTransition("blocked", "running"), true);
});

test("非法迁移要抛 E_TRANSITION", () => {
  assert.throws(() => assertTransition("draft", "done"), (error) => error.code === "E_TRANSITION");
  assert.throws(() => assertTransition("done", "running"), (error) => error.code === "E_TRANSITION");
  assert.throws(() => assertTransition("confirmed", "done"), (error) => error.code === "E_TRANSITION");
});

test("终态不可再迁移", () => {
  for (const state of ["done", "failed", "canceled", "expired"]) {
    assert.equal(isTerminal(state), true);
  }
  assert.equal(isTerminal("blocked"), false);
});
