import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "../lib/output.mjs";
import { moHome, ledgerDir } from "../lib/paths.mjs";
import { listProjects } from "../lib/project.mjs";
import { readEvents } from "../lib/store.mjs";

function readVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

/**
 * 自检：只有必需项失败才算失败。
 * ledger / knowledge / cwd-project 属于"还没用到"，用 ⚠ 提示，不阻塞。
 */
export function doctorCommand(ctx, args) {
  const home = moHome();
  const knowledge = process.env.MO_AGENT_KNOWLEDGE || path.join(home, "knowledge");
  const projects = listProjects(home);
  const events = readEvents(home);

  const checks = [
    { name: "node", required: true, ok: true, value: process.versions.node },
    { name: "mo-agent", required: true, ok: true, value: readVersion() },
    { name: "home", required: true, ok: fs.existsSync(home), value: home },
    { name: "ledger", required: false, ok: fs.existsSync(ledgerDir(home)), value: events.length + " 条事件" },
    { name: "knowledge", required: false, ok: fs.existsSync(knowledge), value: knowledge },
    { name: "projects", required: false, ok: projects.length > 0, value: projects.length + " 个" },
    { name: "cwd-project", required: false, ok: projects.some((p) => (p.paths || []).includes(ctx.cwd)), value: ctx.cwd },
  ];

  const ok = checks.filter((check) => check.required).every((check) => check.ok);
  emit(args.options, { ok, home, knowledge, checks, projects }, () =>
    checks
      .map((check) => (check.ok ? "✓ " : check.required ? "✗ " : "⚠ ") + check.name.padEnd(12) + " " + check.value)
      .join("\n"));
  return ok ? 0 : 1;
}
