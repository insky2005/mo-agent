import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executableExtensions, findExecutable, pathDirs, resolveShell } from "./lib/platform.mjs";
import { commandFor, resolveAgent, EXECUTORS } from "./lib/executors.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-platform-"));
}

test("PATH 按平台分隔符拆分", () => {
  assert.deepEqual(pathDirs("/a:/b::/c", "darwin"), ["/a", "/b", "/c"]);
  assert.deepEqual(pathDirs("C:\\a;C:\\b;;", "win32"), ["C:\\a", "C:\\b"]);
  assert.deepEqual(pathDirs("", "linux"), []);
});

test("PATHEXT：Windows 有默认值，其它平台为空", () => {
  assert.deepEqual(executableExtensions("darwin", {}), [""]);
  assert.deepEqual(executableExtensions("win32", {}), [".COM", ".EXE", ".BAT", ".CMD"]);
  assert.deepEqual(executableExtensions("win32", { PATHEXT: ".EXE;.CMD" }), [".EXE", ".CMD"]);
});

test("findExecutable：POSIX 找 X_OK 文件", () => {
  const dir = tmp();
  const file = path.join(dir, "mo-fake");
  fs.writeFileSync(file, "#!/bin/sh\n");
  fs.chmodSync(file, 0o755);

  assert.equal(findExecutable("mo-fake", { platform: "darwin", env: { PATH: dir } }), file);
  assert.equal(findExecutable("mo-missing", { platform: "darwin", env: { PATH: dir } }), null);
});

test("findExecutable：Windows 按 PATHEXT 找 .CMD/.EXE", () => {
  const dir = tmp();
  const cmd = path.join(dir, "claude.CMD");
  fs.writeFileSync(cmd, "@echo off\n");

  const env = { PATH: dir, PATHEXT: ".CMD;.EXE" };
  assert.equal(findExecutable("claude", { platform: "win32", env }), cmd);
  assert.equal(findExecutable("claude", { platform: "win32", env: { PATH: dir, PATHEXT: ".EXE" } }), null);
});

test("findExecutable：带路径分隔符只查该位置", () => {
  const dir = tmp();
  const file = path.join(dir, "cli");
  fs.writeFileSync(file, "\n");
  fs.chmodSync(file, 0o755);
  assert.equal(findExecutable(file, { platform: "darwin", env: { PATH: "" } }), file);
});

test("resolveShell：POSIX 默认 /bin/sh，Windows 用 ComSpec，MO_SHELL 优先", () => {
  assert.equal(resolveShell("darwin", {}), "/bin/sh");
  assert.equal(resolveShell("linux", {}), "/bin/sh");
  assert.equal(resolveShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(resolveShell("win32", {}), "cmd.exe");
  assert.equal(resolveShell("darwin", { MO_SHELL: "/bin/bash" }), "/bin/bash");
});

test("Windows 执行者选平台命令，pi/qwen 明确不支持", () => {
  assert.equal(commandFor(EXECUTORS["claude-headless"], "win32"), "claude -p --permission-mode acceptEdits");
  assert.equal(commandFor(EXECUTORS["codex-headless"], "win32"), "codex exec -s workspace-write -");
  assert.equal(commandFor(EXECUTORS["pi-headless"], "win32"), null);

  const claude = resolveAgent("claude-headless", { platform: "win32", env: { PATH: "" } });
  assert.equal(claude.command, "claude -p --permission-mode acceptEdits");
  assert.equal(claude.installed, false);

  assert.throws(
    () => resolveAgent("pi-headless", { platform: "win32", env: { PATH: "" } }),
    (error) => error.code === "E_UNSUPPORTED_PLATFORM",
  );
});
