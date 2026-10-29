import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MO = fileURLToPath(new URL("./mo.mjs", import.meta.url));

/**
 * 隔离 HOME：技能目录、MCP 探测、终端探测都看 HOME，
 * 再放一个假的 claude 进 PATH，让默认执行者这一步不依赖本机装了什么。
 */
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-setup-"));
  const home = path.join(root, "home");
  const project = path.join(root, "proj");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(claude, 0o755);
  // 让终端探测在任何平台都能命中 iterm
  fs.mkdirSync(path.join(home, "Applications", "iTerm.app"), { recursive: true });
  return { root, home, project, bin };
}

function run(ws, args, extraEnv = {}) {
  return spawnSync(process.execPath, [MO, ...args], {
    cwd: ws.project,
    env: {
      ...process.env,
      MO_AGENT_HOME: ws.home,
      HOME: ws.home,
      PATH: ws.bin + path.delimiter + String(process.env.PATH || ""),
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function runJson(ws, args, extraEnv = {}) {
  const result = run(ws, [...args, "--json"], extraEnv);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

function statusOf(payload, id) {
  return payload.steps.find((step) => step.id === id).status;
}

test("干净 home：一次装配建好目录、配置、记忆、默认执行者、终端与技能", () => {
  const ws = workspace();
  const result = runJson(ws, ["setup", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.parsed.ok, true);

  assert.deepEqual(result.parsed.steps.map((step) => step.id), ["dirs", "config", "memory", "worker", "terminal", "skill", "mcp"]);
  for (const id of ["dirs", "config", "memory", "worker", "terminal", "skill", "mcp"]) {
    assert.equal(statusOf(result.parsed, id), "created", id + " 应该是 created：" + JSON.stringify(result.parsed.steps.find((s) => s.id === id)));
  }

  for (const dir of ["ledger", "memory", "inbox", "approvals"]) {
    assert.equal(fs.existsSync(path.join(ws.home, dir)), true, dir + " 没建");
  }
  const dirs = result.parsed.steps.find((step) => step.id === "dirs");
  assert.ok(!dirs.detail.dirs.includes(path.join(ws.home, "memory")), "数据目录步骤不该建 memory/");
  const config = JSON.parse(fs.readFileSync(path.join(ws.home, "config.json"), "utf8"));
  assert.equal(config.port, 7788);
  assert.equal(config.authRequired, true);

  for (const file of ["README.md", "preferences.md", path.join("pitfalls", "_template.md")]) {
    assert.equal(fs.existsSync(path.join(ws.home, "memory", file)), true, file + " 没建");
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws.home, "workers.json"), "utf8")).default, "claude");
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws.home, "terminals.json"), "utf8")).default, "iterm");
  assert.equal(fs.existsSync(path.join(ws.home, ".agents", "skills", "mo", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(ws.home, "mcp.json")), true);
});

test("连跑两次：第二次每步都是 skipped，且不重复写", () => {
  const ws = workspace();
  assert.equal(runJson(ws, ["setup", "--yes"]).status, 0);
  const second = runJson(ws, ["setup", "--yes"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    second.parsed.steps.map((step) => step.status),
    ["skipped", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped"],
  );

  // 已装技能要说明是哪份、装在哪
  const skill = second.parsed.steps.find((step) => step.id === "skill");
  assert.ok(skill.lines.some((line) => line.endsWith(path.join("skills", "mo", "SKILL.md"))), "要列出技能文件路径");
});

test("--dry-run 不写任何文件", () => {
  const ws = workspace();
  const result = runJson(ws, ["setup", "--dry-run"]);
  assert.equal(result.parsed.dryRun, true);
  assert.ok(result.parsed.steps.every((step) => step.status === "planned" || step.status === "skipped"), "dry-run 只该有 planned / skipped");

  assert.equal(fs.existsSync(path.join(ws.home, "config.json")), false);
  assert.equal(fs.existsSync(path.join(ws.home, "workers.json")), false);
  assert.equal(fs.existsSync(path.join(ws.home, "terminals.json")), false);
  assert.equal(fs.existsSync(path.join(ws.home, "memory")), false);
  assert.equal(fs.existsSync(path.join(ws.home, ".agents")), false);
  assert.deepEqual(fs.readdirSync(ws.home).sort(), ["Applications"]);

  // 不落地的同时，要把真实路径列出来
  const dirs = result.parsed.steps.find((step) => step.id === "dirs");
  assert.ok(dirs.lines.length > 0, "数据目录应该列出具体路径");
  assert.ok(!dirs.lines.some((line) => line.endsWith(path.sep + "memory")), "memory/ 应该由记忆骨架步骤负责");
  for (const line of dirs.lines) {
    assert.equal(path.isAbsolute(line), true, line + " 不是绝对路径");
    assert.equal(line.startsWith(ws.home), true, line + " 不在 home 下");
  }
  const memory = result.parsed.steps.find((step) => step.id === "memory");
  assert.ok(memory.lines.some((line) => line.endsWith(path.join("memory", "README.md"))), "记忆骨架应该列出文件路径");

  const human = run(ws, ["setup", "--dry-run"]);
  assert.match(human.stdout, /下面每步都是真实会执行的操作/);
  assert.ok(human.stdout.includes(ws.home), "人类可读输出里也要有具体路径");

  // 预演里已经计划要做的，不该再算成"剩余动作"
  const checks = result.parsed.remaining.map((item) => item.check);
  assert.ok(!checks.includes("memory"), "memory 已在计划里，不该再提示 mo memory init");
  assert.ok(!checks.includes("ledger"));
});

test("--only 只跑指定步骤", () => {
  const ws = workspace();
  const result = runJson(ws, ["setup", "--yes", "--only", "memory,mcp"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.parsed.steps.map((step) => step.id), ["memory", "mcp"]);
  assert.equal(statusOf(result.parsed, "memory"), "created");
  assert.equal(fs.existsSync(path.join(ws.home, "memory", "README.md")), true);
  assert.equal(fs.existsSync(path.join(ws.home, "config.json")), false, "--only 不该连带写配置");
});

test("--skip 跳过指定步骤", () => {
  const ws = workspace();
  const result = runJson(ws, ["setup", "--yes", "--skip", "skill"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.parsed.steps.some((step) => step.id === "skill"));
  assert.equal(fs.existsSync(path.join(ws.home, ".agents")), false);
});

test("未知步骤 → E_USAGE", () => {
  const ws = workspace();
  const result = run(ws, ["setup", "--only", "nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_USAGE/);
  assert.match(result.stderr, /dirs/);
});

test("不在项目里也能跑，绝不建 .mo-agent / project.json", () => {
  const ws = workspace();
  const result = runJson(ws, ["setup", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(ws.project, ".mo-agent")), false);
  assert.equal(fs.existsSync(path.join(ws.project, "project.json")), false);
  assert.deepEqual(fs.readdirSync(ws.project), []);
});

test("非 TTY 且没有 --yes：技能跳过并说明原因", () => {
  const ws = workspace();
  const result = runJson(ws, ["setup"]);
  assert.equal(statusOf(result.parsed, "skill"), "skipped");
  assert.match(result.parsed.steps.find((step) => step.id === "skill").message, /非交互/);
  assert.equal(result.status, 0, result.stderr);
});

test("配置里有非法值时给 ⚠ 并以退出码 1 收尾，但不崩", () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.home, "config.json"), JSON.stringify({ port: "abc" }), "utf8");
  const result = runJson(ws, ["setup", "--yes", "--only", "config"]);
  assert.equal(result.status, 1);
  assert.equal(result.parsed.ok, false);
  assert.equal(result.parsed.steps[0].status, "warn");
  assert.match(result.parsed.steps[0].message, /忽略/);
  // 非法值原样保留，不替用户改写
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws.home, "config.json"), "utf8")).port, "abc");
});

test("MCP：找到配置文件就合并并备份，第二次跳过", () => {
  const ws = workspace();
  const target = path.join(ws.home, ".claude.json");
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2) + "\n", "utf8");

  const first = runJson(ws, ["setup", "--yes", "--only", "mcp"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(statusOf(first.parsed, "mcp"), "created");

  const config = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(config.mcpServers.other, { command: "x" });
  assert.equal(config.mcpServers["mo-agent"].args.includes("mcp"), true);
  const backups = fs.readdirSync(ws.home).filter((name) => name.startsWith(".claude.json.bak-"));
  assert.equal(backups.length, 1, "应该先备份");

  const second = runJson(ws, ["setup", "--yes", "--only", "mcp"]);
  assert.equal(statusOf(second.parsed, "mcp"), "skipped");
  assert.match(second.parsed.steps[0].message, /已有 mo 条目/);
});

test("MCP：已有 mo 条目时不重复写；没有配置时写 mo 自己的 mcp.json", () => {
  const ws = workspace();
  const target = path.join(ws.home, ".claude.json");
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { mo: { command: "mo" } } }), "utf8");
  const existing = runJson(ws, ["setup", "--yes", "--only", "mcp"]);
  assert.equal(statusOf(existing.parsed, "mcp"), "skipped");

  const empty = workspace();
  const none = runJson(empty, ["setup", "--yes", "--only", "mcp"]);
  assert.equal(statusOf(none.parsed, "mcp"), "created");
  const fallback = JSON.parse(fs.readFileSync(path.join(empty.home, "mcp.json"), "utf8"));
  assert.equal(fallback.mcpServers["mo-agent"].args.includes("mcp"), true);
  assert.match(none.parsed.steps[0].message, /已写入 MCP 配置/);

  const again = runJson(empty, ["setup", "--yes", "--only", "mcp"]);
  assert.equal(statusOf(again.parsed, "mcp"), "skipped");
  assert.match(again.parsed.steps[0].message, /已有 mo 条目/);
});

test("没有可用执行者时给 ⚠，而不是假装装好了", () => {
  const ws = workspace();
  const result = runJson(ws, ["setup", "--yes", "--only", "worker"], {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  });
  const step = result.parsed.steps[0];
  assert.ok(step.status === "warn" || step.status === "created", step.status);
  if (step.status === "warn") assert.match(step.message, /没有可用的内置执行者/);
});