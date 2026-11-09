import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeNote, notesDir, slugFromTitle, NOTE_MAX_BYTES } from "./lib/notes.mjs";
import { readEvents } from "./lib/store.mjs";
import { TOOLS } from "../core/manager/contract.mjs";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-note-"));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, MO_AGENT_HOME: options.home },
    input: options.input,
    encoding: "utf8",
  });
}

test("note_write：落到 ~/.mo-agent/notes/YYYY-MM-DD-<slug>.md", () => {
  const h = home();
  const note = writeNote({ home: h, title: "派单方案讨论", body: "# 结论\n\n先做 B1。" });
  assert.equal(path.dirname(note.path), notesDir(h));
  assert.match(path.basename(note.path), /^\d{4}-\d{2}-\d{2}-note\.md$/);
  const text = fs.readFileSync(note.path, "utf8");
  assert.match(text, /title: "派单方案讨论"/);
  assert.match(text, /owner: router/);
  assert.match(text, /先做 B1。/);
});

test("note_write：同日同名不覆盖，自动加 -2、-3", () => {
  const h = home();
  const first = writeNote({ home: h, title: "决策", slug: "decision", body: "v1" });
  const second = writeNote({ home: h, title: "决策", slug: "decision", body: "v2" });
  assert.match(path.basename(first.path), /-decision\.md$/);
  assert.match(path.basename(second.path), /-decision-2\.md$/);
  assert.equal(fs.readFileSync(first.path, "utf8").includes("v1"), true);
});

test("note_write：slug 非法 / 正文为空 / 超过 64KB 都拒绝", () => {
  const h = home();
  assert.throws(() => writeNote({ home: h, title: "x", slug: "Bad Slug", body: "a" }), (e) => e.code === "E_USAGE");
  assert.throws(() => writeNote({ home: h, title: "x", body: "   " }), (e) => e.code === "E_USAGE");
  const big = "a".repeat(NOTE_MAX_BYTES + 1);
  assert.throws(() => writeNote({ home: h, title: "x", body: big }), (e) => e.code === "E_NOTE_TOO_LARGE");
});

test("note_write：账本记 note.written（path / bytes / owner）", () => {
  const h = home();
  const note = writeNote({ home: h, title: "台账", body: "hello" });
  const events = readEvents(h).filter((event) => event.type === "note.written");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.bytes, 5);
  assert.equal(events[0].payload.owner, "router");
  assert.match(events[0].payload.path, /notes\//);
  assert.equal(note.bytes, 5);
});

test("slugFromTitle：中文标题退化成 note，英文转连字符", () => {
  assert.equal(slugFromTitle("方案讨论"), "note");
  assert.equal(slugFromTitle("Router Design Notes"), "router-design-notes");
});

test("CLI：mo internal note-write --file - 读 stdin JSON", () => {
  const h = home();
  const result = run(["internal", "note-write", "--file", "-", "--json"], {
    home: h,
    input: JSON.stringify({ title: "CLI 纪要", body: "从 stdin 写进来", tags: ["cli"] }),
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tags[0], "cli");
  assert.match(fs.readFileSync(parsed.path, "utf8"), /从 stdin 写进来/);
});

test("MCP 工具清单里有 note_write，且不带路径参数", () => {
  const tool = TOOLS.find((item) => item.name === "note_write");
  assert.ok(tool, "缺少 note_write");
  assert.deepEqual(tool.schema.required, ["title", "body"]);
  assert.equal(Object.keys(tool.schema.properties).includes("path"), false);
});
