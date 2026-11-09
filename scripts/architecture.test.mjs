import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 依赖方向守卫：把 docs/architecture.md §5 的表变成会失败的测试。
 *
 * 判据不是"能不能 import"，而是"这一层该不该认识那一层"。
 * 已知违规写在 KNOWN_DEBT 里：只许减少，不许新增。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = ["core", "adapters", "approvals", "cli", "host", "app", "desktop", "hooks", "integrations", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".cottontail-tmp", ".build", "dist", "docs", "artifacts", "runtime"]);

/** 允许的跨层依赖；不在表里的边一律非法 */
const ALLOWED = new Set([
  "adapters → core",
  "approvals → core",
  "cli → core",
  "host → core",
  "host → cli",
  "host → adapters",
  "host → approvals",
  "scripts → core",
  "scripts → cli",
  "scripts → host",
  "scripts → adapters",
  "scripts → approvals",
  "scripts → integrations",
]);

/**
 * 已知违规：现在是空的。
 * 曾经有 6 处 cli → host/router/*（Router 实现住在接口层），P1 已把它们下移到 cli/lib。
 * 这里保留集合本身：以后真有临时债，写进来并注明还债期限。
 */
const KNOWN_DEBT = new Set();

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|cjs)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) out.push(full);
  }
  return out;
}

function layerOf(absolute) {
  const first = path.relative(ROOT, absolute).split(path.sep)[0];
  return LAYERS.includes(first) ? first : null;
}

function collectEdges() {
  const edges = new Map();
  for (const file of walk(ROOT)) {
    const from = layerOf(file);
    if (!from) continue;
    const text = fs.readFileSync(file, "utf8");
    const re = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
    let match;
    while ((match = re.exec(text))) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const to = layerOf(path.resolve(path.dirname(file), spec));
      if (!to || to === from) continue;
      const key = from + " → " + to;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(path.relative(ROOT, file));
    }
  }
  return edges;
}

test("跨层依赖只允许出现在白名单里", () => {
  const edges = collectEdges();
  const unknown = [...edges.keys()].filter((key) => !ALLOWED.has(key) && !KNOWN_DEBT.has(key));
  assert.deepEqual(unknown, [], "出现了未登记的跨层依赖：" + unknown.join(", "));
});

test("cli 不允许 import host（不许再留余量）", () => {
  const edges = collectEdges();
  const offenders = edges.get("cli → host") || [];
  // 曾经有 6 处（setup ×4、doctor ×2），P1 已全部下移到 cli/lib。
  // 这里不再保留余量：出现一处就是分层错了。
  assert.deepEqual(offenders, [], "cli → host 的反向依赖：" + offenders.join(", "));
});

test("应用层不许反向依赖接口层（cli/lib 不能引 cli/commands）", () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, "cli", "lib"))) {
    const text = fs.readFileSync(file, "utf8");
    const re = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
    let match;
    while ((match = re.exec(text))) {
      if (!match[1].startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), match[1]);
      if (target.includes(path.join("cli", "commands"))) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual([...new Set(offenders)], [], "cli/lib 里出现了对 cli/commands 的依赖");
});

test("接口层（cli/commands）不许反向依赖 host", () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, "cli", "commands"))) {
    const text = fs.readFileSync(file, "utf8");
    const re = /from\s+["']([^"']*host\/[^"']*)["']/g;
    if (re.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], "cli/commands 里出现了对 host 的依赖");
});

test("core 不认识任何更高层", () => {
  const edges = collectEdges();
  const outbound = [...edges.keys()].filter((key) => key.startsWith("core → "));
  assert.deepEqual(outbound, [], "core 出现了对外依赖：" + outbound.join(", "));
});

test("前端与壳不 import 后端模块（只走 HTTP / 子进程）", () => {
  const edges = collectEdges();
  const bad = [...edges.keys()].filter((key) => key.startsWith("app → ") || key.startsWith("desktop → "));
  assert.deepEqual(bad, [], "界面层直接 import 了后端：" + bad.join(", "));
});

/**
 * 分层守卫的第二组（D1）：cli/lib 是"应用内核"，不是随便什么都能往里加。
 *  - host 只能复用内核模块，不许碰呈现层（output/help/args/skill-content）；
 *  - 内核模块不许自己写 stdout —— 输出只有 output.mjs 一个出口。
 */
const HOST_CLI_ALLOWED = new Set([
  "paths.mjs",
  "fsx.mjs",
  "config.mjs",
  "project.mjs",
  "store.mjs",
  "approvals.mjs",
  "dispatch.mjs",
  "workers-config.mjs",
  "self.mjs",
  "router-argv.mjs",
  "router-install.mjs",
  "router-manager.mjs",
  "router-paths.mjs",
  "router-credentials.mjs",
  "router-probe.mjs",
  "router-runtimes.mjs",
  "router-script.mjs",
  "router-terminal.mjs",
  "router-node.mjs",
]);

test("host 只复用 cli/lib 的内核模块，不碰呈现层", () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, "host"))) {
    const text = fs.readFileSync(file, "utf8");
    const re = /(?:from\s+|import\s*\(\s*)["'](\.\.\/cli\/(?:lib\/)?[^"']+)["']/g;
    let match;
    while ((match = re.exec(text))) {
      const relative = match[1];
      if (relative.startsWith("../cli/commands/")) {
        offenders.push(path.relative(ROOT, file) + " → " + relative);
        continue;
      }
      const name = path.basename(relative);
      if (!HOST_CLI_ALLOWED.has(name)) offenders.push(path.relative(ROOT, file) + " → " + relative);
    }
  }
  assert.deepEqual(offenders, [], "host 引用了不该复用的 cli 模块：" + offenders.join(", "));
});

test("cli/lib 不直接写 stdout（输出只有 cli/ui/output.mjs 一个出口）", () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, "cli", "lib"))) {
    const text = fs.readFileSync(file, "utf8");
    // 只看"语句位置"的写入；命令行字符串里的 process.stdout.write 不算
    if (/^[ \t]*(?:process\.stdout\.write|console\.log)\b/m.test(text)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], "cli/lib 里出现了直接输出：" + offenders.join(", "));
});

test("cli/lib 是内核：不许依赖 cli/ui 与 cli/commands", () => {
  const offenders = [];
  const re = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  for (const file of walk(path.join(ROOT, "cli", "lib"))) {
    const text = fs.readFileSync(file, "utf8");
    let match;
    while ((match = re.exec(text))) {
      if (!match[1].startsWith(".")) continue;
      const relative = path.relative(ROOT, path.resolve(path.dirname(file), match[1]));
      if (relative.startsWith(path.join("cli", "ui")) || relative.startsWith(path.join("cli", "commands"))) {
        offenders.push(path.relative(ROOT, file) + " → " + match[1]);
      }
    }
  }
  assert.deepEqual(offenders, [], "cli/lib 依赖了界面层：" + offenders.join(", "));
});

test("cli/ui 是界面层：不许依赖 cli/commands", () => {
  const offenders = [];
  const re = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  for (const file of walk(path.join(ROOT, "cli", "ui"))) {
    const text = fs.readFileSync(file, "utf8");
    let match;
    while ((match = re.exec(text))) {
      if (!match[1].startsWith(".")) continue;
      const relative = path.relative(ROOT, path.resolve(path.dirname(file), match[1]));
      if (relative.startsWith(path.join("cli", "commands"))) {
        offenders.push(path.relative(ROOT, file) + " → " + match[1]);
      }
    }
  }
  assert.deepEqual(offenders, [], "cli/ui 依赖了命令层：" + offenders.join(", "));
});
