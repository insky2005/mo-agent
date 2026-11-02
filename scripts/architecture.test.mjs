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

/** 已知违规：cli 反向依赖 host。只许变少。 */
const KNOWN_DEBT = new Set([
  "cli → host",
]);

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

test("已知违规不许扩大：cli 不能 import host 的新模块", () => {
  const edges = collectEdges();
  const offenders = edges.get("cli → host") || [];
  // 6 处（setup ×4、doctor ×2）是登记的债；超过就是新增，直接失败
  assert.ok(offenders.length <= 6, "cli → host 的反向依赖变多了：" + offenders.join(", "));
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
