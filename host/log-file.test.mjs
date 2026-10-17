import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRotatingSink } from "./log-file.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-log-file-"));
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    return null;
  }
}

test("未超过上限时只追加，不轮转", () => {
  const dir = tmpDir();
  const file = path.join(dir, "host.log");
  const sink = createRotatingSink({ file, maxBytes: 100, keep: 3 });
  sink.write("aaaa\n");
  sink.write("bbbb\n");
  assert.equal(read(file), "aaaa\nbbbb\n");
  assert.equal(fs.existsSync(file + ".1"), false);
  assert.equal(sink.size, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("超过上限时生成 .1，当前文件从空开始", () => {
  const dir = tmpDir();
  const file = path.join(dir, "host.log");
  const sink = createRotatingSink({ file, maxBytes: 10, keep: 3 });
  sink.write("aaaaa\n"); // 6
  sink.write("bbbbb\n"); // 6 -> 12 > 10，先轮转再写
  assert.equal(read(file + ".1"), "aaaaa\n");
  assert.equal(read(file), "bbbbb\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("最多保留 keep 份，更老的被删除", () => {
  const dir = tmpDir();
  const file = path.join(dir, "host.log");
  const sink = createRotatingSink({ file, maxBytes: 3, keep: 3 });
  // 每行 3 字节，正好一份文件一行，每写一行都轮转一次
  for (const line of ["11\n", "22\n", "33\n", "44\n", "55\n"]) sink.write(line);
  assert.equal(read(file), "55\n");
  assert.equal(read(file + ".1"), "44\n");
  assert.equal(read(file + ".2"), "33\n");
  assert.equal(read(file + ".3"), "22\n");
  assert.equal(fs.existsSync(file + ".4"), false);
  // "11" 应该已经被挤掉
  assert.equal(read(file + ".3").includes("11"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("keep=0 时直接截断，不留历史文件", () => {
  const dir = tmpDir();
  const file = path.join(dir, "host.log");
  const sink = createRotatingSink({ file, maxBytes: 6, keep: 0 });
  sink.write("aaaaa\n");
  sink.write("bbbbb\n");
  assert.equal(read(file), "bbbbb\n");
  assert.equal(fs.existsSync(file + ".1"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("目录不存在时自动创建", () => {
  const dir = tmpDir();
  const file = path.join(dir, "nested", "logs", "host.log");
  const sink = createRotatingSink({ file });
  assert.equal(sink.write("hello\n"), true);
  assert.equal(read(file), "hello\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("已有文件的大小会被继承，不会从 0 重新计算", () => {
  const dir = tmpDir();
  const file = path.join(dir, "host.log");
  fs.writeFileSync(file, "12345678\n"); // 9
  const sink = createRotatingSink({ file, maxBytes: 10, keep: 3 });
  assert.equal(sink.size, 9);
  sink.write("aa\n"); // 9 + 3 > 10 -> 轮转
  assert.equal(read(file + ".1"), "12345678\n");
  assert.equal(read(file), "aa\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("写入失败不会抛错，会回调 onError", () => {
  const dir = tmpDir();
  const file = path.join(dir, "host.log");
  const errors = [];
  const sink = createRotatingSink({ file, onError: (error) => errors.push(error) });
  fs.mkdirSync(file); // 用目录占住路径，写文件必然失败
  assert.equal(sink.write("x\n"), false);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("close 之后不再写入", () => {
  const dir = tmpDir();
  const file = path.join(dir, "host.log");
  const sink = createRotatingSink({ file });
  sink.close();
  assert.equal(sink.write("x\n"), false);
  assert.equal(read(file), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
