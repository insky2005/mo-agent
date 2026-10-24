import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentCommand } from "./commands/agent.mjs";
import { attachProject } from "./lib/project.mjs";
import { SKILL_MD } from "./lib/skill-content.mjs";

function workspace({ withSkill = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agentcmd-"));
  const project = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.MO_AGENT_HOME = path.join(home, ".mo-agent");
  attachProject(project, { home: process.env.MO_AGENT_HOME });
  if (withSkill) {
    const dir = path.join(home, ".agents", "skills", "mo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD);
  }
  return { root, project, home };
}

function run(ctx, args, options = {}) {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const code = agentCommand({ cwd: ctx.project }, { positional: args, options });
    return { code, out: lines.join("") };
  } finally {
    process.stdout.write = original;
  }
}

test("技能已装 → 写指针块", () => {
  const ws = workspace({ withSkill: true });
  run(ws, ["init"]);
  const text = fs.readFileSync(path.join(ws.project, "AGENTS.md"), "utf8");
  assert.match(text, /mo 技能/);
  assert.match(text, />>> mo >>>/);
});

test("技能未装 → 写 MO.md 并在 AGENTS.md 里引用", () => {
  const ws = workspace();
  run(ws, ["init"]);
  const agents = fs.readFileSync(path.join(ws.project, "AGENTS.md"), "utf8");
  assert.match(agents, /\.mo-agent\/MO\.md/);
  const doc = fs.readFileSync(path.join(ws.project, ".mo-agent", "MO.md"), "utf8");
  assert.match(doc, /mo task create/);
  assert.match(doc, /missing_receipt/);
});

test("重复执行只保留一段", () => {
  const ws = workspace();
  run(ws, ["init"]);
  run(ws, ["init"]);
  const text = fs.readFileSync(path.join(ws.project, "AGENTS.md"), "utf8");
  assert.equal(text.split(">>> mo >>>").length - 1, 1);
});

test("保留原有内容，只在末尾追加", () => {
  const ws = workspace();
  const file = path.join(ws.project, "AGENTS.md");
  fs.writeFileSync(file, "# 项目说明\n\n原有内容。\n");
  run(ws, ["init"]);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /原有内容。/);
  assert.ok(text.indexOf("原有内容。") < text.indexOf(">>> mo >>>"));
});

test("remove 只去掉自己那段", () => {
  const ws = workspace();
  const file = path.join(ws.project, "AGENTS.md");
  fs.writeFileSync(file, "# 项目说明\n");
  run(ws, ["init"]);
  run(ws, ["remove"]);
  const text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, />>> mo >>>/);
  assert.match(text, /# 项目说明/);
});

test("已有 CLAUDE.md 时优先写它", () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.project, "CLAUDE.md"), "# 指令\n");
  run(ws, ["init"]);
  assert.equal(fs.existsSync(path.join(ws.project, "AGENTS.md")), false);
  assert.match(fs.readFileSync(path.join(ws.project, "CLAUDE.md"), "utf8"), />>> mo >>>/);
});

test("--mode 可强制内联", () => {
  const ws = workspace({ withSkill: true });
  run(ws, ["init"], { mode: ["inline"] });
  assert.match(fs.readFileSync(path.join(ws.project, "AGENTS.md"), "utf8"), /mo task create/);
});

test("--mode inline 不生成 MO.md", () => {
  const ws = workspace();
  run(ws, ["init"], { mode: ["inline"] });
  assert.equal(fs.existsSync(path.join(ws.project, ".mo-agent", "MO.md")), false);
});