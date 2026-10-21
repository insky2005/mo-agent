import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTitleSource,
  decodeFileUri,
  defaultDbPath,
  findSqlite3,
  normalizeTitle,
  parseIdeTabs,
  parseIdeViews,
  parseTitles,
} from "./qoder-cn-titles.mjs";

const quiet = { debug() {} };

test("parseTitles：只收有效行，坏输出当空", () => {
  const map = parseTitles(JSON.stringify([
    { session_id: "a", title: "优化客户端权限交互" },
    { session_id: "b", title: "  " },
    { session_id: "", title: "x" },
    { session_id: "c", title: "多行\n标题" },
  ]));
  assert.equal(map.get("a"), "优化客户端权限交互");
  assert.equal(map.get("c"), "多行 标题");
  assert.equal(map.has("b"), false);
  assert.equal(map.has(""), false);
  assert.equal(parseTitles("not json").size, 0);
  assert.equal(parseTitles('{"a":1}').size, 0);
  assert.equal(parseTitles("").size, 0);
});

test("normalizeTitle：压平空白并截断", () => {
  assert.equal(normalizeTitle("  多行\n  标题  "), "多行 标题");
  const long = "标题".repeat(60);
  const short = normalizeTitle(long);
  assert.equal(short.length, 80);
  assert.ok(short.endsWith("…"));
});

test("createTitleSource：读库、节流、失败降级", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-qoder-titles-"));
  const db = path.join(dir, "main.sqlite");
  fs.writeFileSync(db, "");
  let clock = 1000;
  let calls = 0;
  const source = createTitleSource({
    dbPath: db,
    ideWorkspaceRoot: "",
    sqlitePath: "/fake/sqlite3",
    nodeSqlite: null,
    log: quiet,
    now: () => clock,
    run: () => {
      calls += 1;
      return JSON.stringify([{ session_id: "s1", title: "排查授权失败" }]);
    },
  });

  source.refresh();
  assert.equal(source.title("s1"), "排查授权失败");
  assert.equal(calls, 1);

  // 30 秒内不重复读库
  clock += 1000;
  source.refresh();
  source.refresh();
  assert.equal(calls, 1);

  // 到点再读
  clock += 30 * 1000;
  source.refresh();
  assert.equal(calls, 2);

  // force 立刻读
  source.refresh(true);
  assert.equal(calls, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createTitleSource：sqlite 缺失 / 读失败都不抛", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-qoder-titles-"));
  const db = path.join(dir, "main.sqlite");
  fs.writeFileSync(db, "");
  const missing = createTitleSource({ dbPath: db, sqlitePath: "", nodeSqlite: null, ideWorkspaceRoot: "", log: quiet });
  missing.refresh(true);
  assert.equal(missing.title("s1"), "");

  const broken = createTitleSource({
    dbPath: db,
    ideWorkspaceRoot: "",
    sqlitePath: "/fake/sqlite3",
    nodeSqlite: null,
    log: quiet,
    run: () => { throw new Error("boom"); },
  });
  broken.refresh(true);
  assert.equal(broken.title("s1"), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("defaultDbPath / findSqlite3", () => {
  assert.equal(
    defaultDbPath("/Users/x"),
    path.join("/Users/x", "Library", "Application Support", "com.qodercn.app.stable", "main.sqlite")
  );
  assert.equal(findSqlite3({ MO_AGENT_SQLITE3: "/custom/sqlite3" }, (p) => p === "/custom/sqlite3"), "/custom/sqlite3");
  assert.equal(findSqlite3({}, () => false), "");
});

test("createTitleSource：优先用内置 node:sqlite，不 spawn CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-qoder-titles-"));
  const db = path.join(dir, "main.sqlite");
  fs.writeFileSync(db, "");
  let opened = 0;
  const fake = {
    DatabaseSync: class {
      constructor(file, options) {
        opened += 1;
        assert.equal(file, db);
        assert.equal(options.readOnly, true);
      }
      prepare(sql) {
        assert.match(sql, /chat_sessions/);
        return { all: () => [{ session_id: "s1", title: "内置 sqlite 标题" }] };
      }
      close() {}
    },
  };
  const source = createTitleSource({
    dbPath: db,
    ideWorkspaceRoot: "",
    nodeSqlite: fake,
    sqlitePath: "/fake/sqlite3",
    log: quiet,
    run: () => { throw new Error("不应该 spawn CLI"); },
  });
  source.refresh(true);
  assert.equal(opened, 1);
  assert.equal(source.title("s1"), "内置 sqlite 标题");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createTitleSource：node:sqlite 失败时回退 CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-qoder-titles-"));
  const db = path.join(dir, "main.sqlite");
  fs.writeFileSync(db, "");
  const fake = {
    DatabaseSync: class {
      constructor() { throw new Error("node sqlite boom"); }
    },
  };
  const source = createTitleSource({
    dbPath: db,
    ideWorkspaceRoot: "",
    nodeSqlite: fake,
    sqlitePath: "/fake/sqlite3",
    log: quiet,
    run: () => JSON.stringify([{ session_id: "s1", title: "CLI 标题" }]),
  });
  source.refresh(true);
  assert.equal(source.title("s1"), "CLI 标题");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("IDE 标题解析：chat.views / chat.tabs / file URI", () => {
  assert.equal(
    decodeFileUri("file:///Users/dev/c/work.ai/git/institute/authx-platform"),
    "/Users/dev/c/work.ai/git/institute/authx-platform"
  );
  const views = parseIdeViews(JSON.stringify([
    { sessionId: "s1", title: "分析 JSESSIONID 频繁变更原因" },
    { sessionId: "", title: "x" },
  ]));
  assert.equal(views.get("s1"), "分析 JSESSIONID 频繁变更原因");
  const tabs = parseIdeTabs(JSON.stringify({ tabs: [{ sessionId: "s2", title: "多行\n标题" }] }));
  assert.equal(tabs.get("s2"), "多行 标题");
  assert.equal(parseIdeViews("bad").size, 0);
  assert.equal(parseIdeTabs("{}").size, 0);
});