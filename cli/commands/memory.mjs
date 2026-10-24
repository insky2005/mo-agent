import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { all, one, has } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { ensureDir } from "../lib/fsx.mjs";
import { knowledgeDir, loadKnowledge, recallKnowledge } from "../lib/knowledge.mjs";

const USAGE = "可用：recall / list / init / path";

export function memoryCommand(ctx, args) {
  const sub = args.positional[0];
  const home = moHome();
  if (sub === "recall") return recallCommand(args, home);
  if (sub === "list") return listCommand(args, home);
  if (sub === "init") return initCommand(args, home);
  if (sub === "path") return pathCommand(args, home);
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
      return "没有命中条目（知识库共 " + result.total + " 条）" + hintFor(result.warnings);
    }
    const lines = result.matched.map((entry) => {
      const meta = [entry.scope, entry.id, "score=" + entry.score].join(" · ");
      const body = String(entry.body || "").replace(/\s*\n\s*/g, " ").trim();
      return meta + "\n  " + entry.title + (body ? "\n  " + body : "");
    });
    return lines.join("\n\n") + hintFor(result.warnings);
  });
  return 0;
}

function hintFor(warnings) {
  return warnings.includes("W_KNOWLEDGE_EMPTY") ? "\n（知识库是空的，先运行 mo memory init）" : "";
}

function listCommand(args, home) {
  const loaded = loadKnowledge({ home });
  const scopes = scopeArgs(args);
  const entries = scopes ? loaded.entries.filter((entry) => scopes.includes(entry.scope)) : loaded.entries;

  emit(
    args.options,
    { ok: true, dir: loaded.dir, total: entries.length, entries: entries.map(stripForJson) },
    () => {
      if (!entries.length) return "知识库是空的（" + loaded.dir + "）\n先运行 mo memory init";
      const rows = entries.map((entry) => [entry.scope, entry.id, entry.title]);
      return "知识库：" + loaded.dir + "\n\n" + table(rows, ["scope", "id", "title"]);
    },
  );
  return 0;
}

function pathCommand(args, home) {
  const { dir, explicit } = knowledgeDir(home);
  emit(args.options, { ok: true, dir, explicit }, dir);
  return 0;
}

const README = [
  "# 知识库",
  "",
  "这里的条目会在派单时按任务卡内容召回，注入执行者拿到的信封。全部是本地纯文本。",
  "",
  "## 目录",
  "",
  "- \`preferences.md\` — 我的偏好",
  "- \`pitfalls/*.md\` — 避坑",
  "- \`decisions/*.md\` — 已定的决策",
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

function initCommand(args, home) {
  const { dir } = knowledgeDir(home);
  ensureDir(path.join(dir, "pitfalls"));
  ensureDir(path.join(dir, "decisions"));

  const created = [];
  const ensure = (file, content) => {
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, content, "utf8");
    created.push(path.relative(dir, file));
  };

  ensure(path.join(dir, "README.md"), README);
  ensure(path.join(dir, "preferences.md"), "# 偏好\n\n");
  ensure(path.join(dir, "pitfalls", "_template.md"), TEMPLATE);
  ensure(path.join(dir, "decisions", "_template.md"), TEMPLATE);

  emit(
    args.options,
    { ok: true, dir, created },
    () => (created.length ? "已创建知识库：" + dir + "\n" + created.map((file) => "  + " + file).join("\n") : "知识库已存在：" + dir + "\n（没有覆盖任何文件）"),
  );
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
