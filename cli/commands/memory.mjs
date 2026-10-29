import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { all, one, has } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { ensureDir } from "../lib/fsx.mjs";
import { memoryDir, loadKnowledge, recallKnowledge } from "../lib/knowledge.mjs";
import {
  appendCandidate,
  deleteCandidate,
  listCandidates,
  readCandidate,
  saveCandidate,
} from "../lib/candidates.mjs";
import { detectConflict, describeConflict, normalizeCandidate, validateCandidate } from "../../core/knowledge/candidate.mjs";
import { appendEvent } from "../lib/store.mjs";

const USAGE = "可用：recall / list / init / path / migrate / propose / candidates / accept / reject";

export function memoryCommand(ctx, args) {
  const sub = args.positional[0];
  const home = moHome();
  if (sub === "recall") return recallCommand(args, home);
  if (sub === "list") return listCommand(args, home);
  if (sub === "init") return initCommand(args, home);
  if (sub === "path") return pathCommand(args, home);
  if (sub === "migrate") return migrateCommand(args, home);
  if (sub === "propose") return proposeCommand(args, home);
  if (sub === "candidates") return candidatesCommand(args, home);
  if (sub === "accept") return acceptCommand(args, home);
  if (sub === "reject") return rejectCommand(args, home);
  throw new MoError("E_USAGE", "未知子命令：memory " + (sub || "") + "（" + USAGE + "）");
}

function scopeArgs(args) {
  const raw = all(args.options, "scope").join(",");
  return raw ? raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean) : null;
}

function recallCommand(args, home) {
  const query = args.positional.slice(1).join(" ").trim();
  if (!query) {
    throw new MoError("E_USAGE", "缺少查询词", { hint: '例如：mo memory recall "派单 超时"' });
  }

  const limit = one(args.options, "limit");
  const result = recallKnowledge({
    home,
    query,
    limit: limit ? Number(limit) : undefined,
    scopes: scopeArgs(args),
    includeAll: has(args.options, "all"),
  });

  const payload = {
    ok: true,
    query: result.query,
    dir: result.dir,
    total: result.total,
    matched: result.matched.map(stripForJson),
    warnings: result.warnings,
  };

  emit(args.options, payload, () => {
    if (!result.matched.length) {
      return "没有命中条目（记忆库共 " + result.total + " 条）" + hintFor(result);
    }
    const lines = result.matched.map((entry) => {
      const meta = [entry.scope, entry.id, "score=" + entry.score].join(" · ");
      const body = String(entry.body || "").replace(/\s*\n\s*/g, " ").trim();
      return meta + "\n  " + entry.title + (body ? "\n  " + body : "");
    });
    return lines.join("\n\n") + hintFor(result);
  });
  return 0;
}

function hintFor(result) {
  const warnings = result.warnings || [];
  const lines = [];
  if (warnings.includes("W_MEMORY_EMPTY")) lines.push("（记忆库是空的，先运行 mo memory init）");
  if (warnings.includes("W_MEMORY_LEGACY_DIR")) {
    lines.push("（正在用旧目录 " + result.dir + "；mo memory migrate 可搬到 " + (result.legacyTarget || "memory/") + "）");
  }
  return lines.length ? "\n" + lines.join("\n") : "";
}

function listCommand(args, home) {
  const loaded = loadKnowledge({ home });
  const scopes = scopeArgs(args);
  const entries = scopes ? loaded.entries.filter((entry) => scopes.includes(entry.scope)) : loaded.entries;

  emit(
    args.options,
    { ok: true, dir: loaded.dir, total: entries.length, entries: entries.map(stripForJson) },
    () => {
      if (!entries.length) return "记忆库是空的（" + loaded.dir + "）\n先运行 mo memory init";
      const rows = entries.map((entry) => [entry.scope, entry.id, entry.title]);
      return "记忆库：" + loaded.dir + "\n\n" + table(rows, ["scope", "id", "title"]);
    },
  );
  return 0;
}

function pathCommand(args, home) {
  const { dir, explicit, source, target } = memoryDir(home);
  const legacy = source === "legacy" || source === "legacy-env";
  emit(
    args.options,
    { ok: true, dir, explicit, source, ...(target ? { target } : {}) },
    () => dir + (legacy ? "\n（旧目录；mo memory migrate 可搬到 " + (target || path.join(home, "memory")) + "）" : ""),
  );
  return 0;
}

/**
 * 把老目录搬到 ~/.mo-agent/memory。
 * 不覆盖、不合并：目标已存在就拒绝，交给用户自己处理。
 */
function migrateCommand(args, home) {
  const { dir, source, target } = memoryDir(home);
  const to = target || path.join(home, "memory");

  if (source === "env" || source === "legacy-env") {
    throw new MoError("E_USAGE", "当前用环境变量指定了记忆库（" + dir + "），不迁移", {
      hint: "去掉 MO_AGENT_MEMORY / MO_AGENT_KNOWLEDGE 后再迁移",
    });
  }
  if (dir === to) {
    // memory 已经在用，但旧的 knowledge/ 还有东西：只提示，不替用户合并
    const legacy = path.join(home, "knowledge");
    if (fs.existsSync(legacy) && fs.readdirSync(legacy).length) {
      throw new MoError("E_USAGE", "两个目录都有内容：" + to + " 与 " + legacy, {
        hint: "memory 已在用；把 knowledge/ 里的条目手动合并过去，或删掉旧目录",
      });
    }
    emit(args.options, { ok: true, dir, migrated: false }, "已经在用 memory 目录：" + dir);
    return 0;
  }
  if (fs.existsSync(to) && fs.readdirSync(to).length) {
    throw new MoError("E_USAGE", "目标目录已存在且不是空的：" + to, {
      hint: "先自己合并或删掉它，再运行 mo memory migrate",
    });
  }

  const dryRun = has(args.options, "dry-run");
  if (!dryRun) {
    fs.renameSync(dir, to);
    const legacyCandidates = path.join(to, "_candidates");
    if (fs.existsSync(legacyCandidates)) fs.renameSync(legacyCandidates, path.join(to, "candidates"));
  }

  emit(
    args.options,
    { ok: true, from: dir, to, migrated: !dryRun },
    () =>
      dryRun
        ? "将把 " + dir + " 搬到 " + to + "（--dry-run，没有动文件）"
        : "✓ 已迁移\n\n  从   " + dir + "\n  到   " + to,
  );
  return 0;
}

const README = [
  "# 记忆库",
  "",
  "这里的条目会在派单时按任务卡内容召回，注入执行者拿到的信封。全部是本地纯文本。",
  "",
  "## 目录",
  "",
  "- \`preferences.md\` — 我的偏好",
  "- \`pitfalls/*.md\` — 避坑",
  "- \`decisions/*.md\` — 已定的决策",
  "- \`candidates/*.json\` — 待裁决的候选（不会进召回）",
  "",
  "## 条目格式",
  "",
  "一个 \`## 标题\` 就是一个条目，标题下面写正文；开头可以带匹配用的元数据：",
  "",
  "\`\`\`markdown",
  "## 派单超时不要直接重试",
  "",
  "- trigger: 派单, 超时, retry",
  "- tags: 任务",
  "",
  "先看 mo task logs，确认是执行者卡住还是回执没写。",
  "\`\`\`",
  "",
  "- \`trigger\` / \`tags\` 只是加权用的线索，正文和标题也会参与匹配；",
  "- 文件名以 \`_\` 开头（如 \`_template.md\`）不会被召回，适合放示例；",
  "- 改完立即生效，没有索引和缓存。",
  "",
].join("\n");

const TEMPLATE = [
  "## 一句话症状",
  "",
  "- trigger: 什么时候会遇到",
  "- tags: 分类",
  "",
  "**现象**：",
  "**原因**：",
  "**解法**：",
  "",
].join("\n");

/**
 * 建记忆骨架，只补缺、不覆盖。mo setup 直接复用它。
 * dryRun 只算"会建哪些"，不落盘。
 * @returns {{dir: string, created: string[], written: boolean}}
 */
export function initMemory({ home, dryRun = false } = {}) {
  const { dir } = memoryDir(home);
  const wanted = [
    ["README.md", README],
    ["preferences.md", "# 偏好\n\n"],
    [path.join("pitfalls", "_template.md"), TEMPLATE],
    [path.join("decisions", "_template.md"), TEMPLATE],
  ];

  if (!dryRun) {
    ensureDir(path.join(dir, "pitfalls"));
    ensureDir(path.join(dir, "decisions"));
    ensureDir(path.join(dir, "candidates"));
  }

  const created = [];
  for (const [relative, content] of wanted) {
    const file = path.join(dir, relative);
    if (fs.existsSync(file)) continue;
    if (!dryRun) fs.writeFileSync(file, content, "utf8");
    created.push(relative);
  }
  return { dir, created, written: !dryRun };
}

function initCommand(args, home) {
  const { dir, created } = initMemory({ home });
  emit(
    args.options,
    { ok: true, dir, created },
    () => (created.length ? "已创建记忆库：" + dir + "\n" + created.map((file) => "  + " + file).join("\n") : "记忆库已存在：" + dir + "\n（没有覆盖任何文件）"),
  );
  return 0;
}

function readInput(file) {
  if (!file || file === true || file === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(file, "utf8");
}

/** 候选既可以从 stdin/文件读 JSON，也可以用参数拼，方便人手工提一条 */
function proposalInput(args) {
  if (has(args.options, "title")) {
    return {
      scope: one(args.options, "scope", "pitfalls"),
      title: one(args.options, "title"),
      trigger: all(args.options, "trigger"),
      tags: all(args.options, "tag"),
      body: one(args.options, "body", ""),
      source: one(args.options, "source", "agent"),
      taskId: one(args.options, "task"),
      project: one(args.options, "project"),
    };
  }
  const raw = readInput(one(args.options, "file"));
  if (!raw.trim()) throw new MoError("E_USAGE", "缺少候选内容", { hint: "从 stdin 或 --file 传入 JSON，或直接用 --title 等参数" });
  try {
    return JSON.parse(raw);
  } catch {
    throw new MoError("E_MEMORY_INVALID", "候选不是合法 JSON");
  }
}

function loadEntriesQuietly(home) {
  try {
    return loadKnowledge({ home }).entries;
  } catch (error) {
    if (error && error.code === "E_MEMORY_UNAVAILABLE") return [];
    throw error;
  }
}

function conflictLines(conflict, candidate) {
  return [
    "  旧   " + conflict.existing.title + (conflict.existing.path ? "（" + conflict.existing.path + "）" : ""),
    "       " + String(conflict.existing.body || "").replace(/\s*\n\s*/g, " ").slice(0, 120),
    "  新   " + candidate.title,
    "       " + String(candidate.body || "").replace(/\s*\n\s*/g, " ").slice(0, 120),
  ].join("\n");
}

function proposeCommand(args, home) {
  const candidate = normalizeCandidate(proposalInput(args));
  const checked = validateCandidate(candidate);
  if (!checked.ok) {
    throw new MoError("E_MEMORY_INVALID", checked.errors.join("；"), {
      errors: checked.errors,
      hint: "候选需要 scope / title / trigger / body（缺触发条件会被拒收）",
    });
  }

  const conflict = describeConflict(detectConflict(candidate, loadEntriesQuietly(home)));
  const saved = saveCandidate({ home, candidate, conflict });

  if (saved.duplicate) {
    emit(
      args.options,
      { ok: true, id: saved.id, duplicate: true, path: saved.file, conflict },
      "已存在相同候选：" + saved.id + "（未重复记录）\n下一步（裁决）：mo memory accept " + saved.id,
    );
    return 0;
  }

  appendEvent(home, {
    type: "memory.proposed",
    project: candidate.project,
    taskId: candidate.taskId,
    actor: "agent",
    payload: { candidateId: saved.id, scope: candidate.scope, title: candidate.title, source: candidate.source },
  });

  if (conflict) process.stderr.write("[W_MEMORY_CONFLICT] 与已有条目冲突，接受时会拒绝写入\n");

  emit(
    args.options,
    { ok: true, id: saved.id, path: saved.file, conflict, candidate },
    () => {
      const lines = [
        "✓ 已记入候选区",
        "",
        "  id     " + saved.id,
        "  类型   " + candidate.scope,
        "  标题   " + candidate.title,
      ];
      if (conflict) lines.push("", "  ⚠ 与已有条目冲突（" + conflict.label + "）", conflictLines(conflict, candidate));
      lines.push("", "下一步（接受）：mo memory accept " + saved.id, "下一步（丢弃）：mo memory reject " + saved.id);
      return lines.join("\n");
    },
  );
  return 0;
}

function candidatesCommand(args, home) {
  const items = listCandidates({ home });
  emit(
    args.options,
    { ok: true, total: items.length, candidates: items.map(({ file, ...item }) => item) },
    () => {
      if (!items.length) return "候选区是空的";
      const rows = items.map((item) => [item.id, item.scope, item.title, item.conflict ? "⚠ 冲突" : ""]);
      return "候选区（" + items.length + " 条，等人裁决）\n\n" + table(rows, ["id", "scope", "title", "冲突"]);
    },
  );
  return 0;
}

function acceptCommand(args, home) {
  const id = args.positional[1] || one(args.options, "id");
  if (!id) throw new MoError("E_USAGE", "缺少候选 id", { hint: "mo memory candidates" });

  const candidate = readCandidate({ home, id });
  const conflict = detectConflict(candidate, loadKnowledge({ home }).entries);
  if (conflict) {
    const info = describeConflict(conflict);
    process.stderr.write("候选与已有条目冲突，未写入\n" + conflictLines(info, candidate) + "\n");
    throw new MoError("E_MEMORY_CONFLICT", "候选与已有条目冲突：" + conflict.entry.title, {
      hint: "改/删旧条目后重试，或 mo memory reject " + id,
    });
  }

  const written = appendCandidate({ home, candidate });
  deleteCandidate({ home, id });
  appendEvent(home, {
    type: "memory.accepted",
    project: candidate.project,
    taskId: candidate.taskId,
    actor: "agent",
    payload: { candidateId: id, scope: candidate.scope, title: candidate.title, file: written.file, entryId: written.entryId },
  });

  emit(
    args.options,
    { ok: true, id, entryId: written.entryId, file: written.file },
    () => ["✓ 已写入记忆库", "", "  条目   " + written.entryId, "  文件   " + written.file].join("\n"),
  );
  return 0;
}

function rejectCommand(args, home) {
  const id = args.positional[1] || one(args.options, "id");
  if (!id) throw new MoError("E_USAGE", "缺少候选 id", { hint: "mo memory candidates" });
  const candidate = readCandidate({ home, id });
  deleteCandidate({ home, id });
  emit(args.options, { ok: true, id, rejected: true }, "✗ 已丢弃候选 " + id + "（" + candidate.title + "）");
  return 0;
}

function stripForJson(entry) {
  return {
    id: entry.id,
    scope: entry.scope,
    title: entry.title,
    body: entry.body,
    trigger: entry.trigger,
    tags: entry.tags,
    path: entry.path,
    ...(entry.score === undefined ? {} : { score: entry.score, hits: entry.hits }),
  };
}