import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { entryId } from "../../core/knowledge/entry.mjs";
import {
  normalizeCandidate,
  renderEntry,
  targetFileName,
  validateCandidate,
  detectConflict,
  describeConflict,
} from "../../core/knowledge/candidate.mjs";
import { ensureDir, listFiles, readJsonSafe, writeJsonAtomic } from "./fsx.mjs";
import { knowledgeDir, loadKnowledge } from "./knowledge.mjs";
import { newCandidateId } from "./ids.mjs";
import { appendEvent } from "./store.mjs";

/**
 * 候选区：拟入知识库但还没被人拍板的条目（B10.1–B10.4）。
 * 存在 knowledge/_candidates/ 下，`_` 前缀让它天然不会被召回。
 */

const ID_PATTERN = /^c_[0-9A-Z]+$/;

export function candidatesDir(home, env = process.env) {
  return path.join(knowledgeDir(home, env).dir, "_candidates");
}

function candidateFile(home, id, env = process.env) {
  if (!ID_PATTERN.test(String(id || ""))) {
    throw new MoError("E_MEMORY_INVALID", "候选 id 不合法：" + id, { hint: "用 mo memory candidates 查看可用 id" });
  }
  return path.join(candidatesDir(home, env), id + ".json");
}

export function listCandidates({ home, env = process.env }) {
  const items = [];
  for (const file of listFiles(candidatesDir(home, env), ".json").sort()) {
    const item = readJsonSafe(file, null);
    if (item && item.id) items.push({ ...item, file });
  }
  return items;
}

export function readCandidate({ home, env = process.env, id }) {
  const file = candidateFile(home, id, env);
  const item = readJsonSafe(file, null);
  if (!item) {
    throw new MoError("E_MEMORY_NOT_FOUND", "没有这个候选：" + id, { hint: "mo memory candidates 查看待裁决列表" });
  }
  return { ...item, file };
}

export function deleteCandidate({ home, env = process.env, id }) {
  fs.rmSync(candidateFile(home, id, env), { force: true });
}

/** 同 scope 同标题的待裁决候选只留一条，避免回执重复上报刷屏 */
export function saveCandidate({ home, env = process.env, candidate, conflict = null }) {
  const existing = listCandidates({ home, env }).find(
    (item) => item.scope === candidate.scope && item.title === candidate.title,
  );
  if (existing) return { ...existing, duplicate: true };

  const id = newCandidateId();
  const item = {
    v: 1,
    id,
    at: new Date().toISOString(),
    ...candidate,
    conflict: conflict || null,
  };
  const file = candidateFile(home, id, env);
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, item);
  return { ...item, file, duplicate: false };
}

/** 接受后的落盘：偏好追加到 preferences.md，避坑/决策一条一个文件 */
export function appendCandidate({ home, env = process.env, candidate }) {
  const { dir } = knowledgeDir(home, env);
  const relative = targetFileName(candidate);
  const file = path.join(dir, relative);
  ensureDir(path.dirname(file));

  const exists = fs.existsSync(file);
  const current = exists ? fs.readFileSync(file, "utf8") : "";
  const prefix = !exists && candidate.scope === "preferences" ? "# 偏好\n\n" : "";
  const spacer = current ? (current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n") : "";
  fs.writeFileSync(file, current + prefix + spacer + renderEntry(candidate), "utf8");

  return { file, entryId: entryId(candidate.scope, relative, candidate.title) };
}

/**
 * B10.1：回执带 pitfalls 时自动生成候选，等人确认——不直接写知识库。
 * 缺触发条件的直接拒收并汇报，不静默丢。
 */
export function proposeFromPitfalls({ home, env = process.env, card, receipt }) {
  const created = [];
  const skipped = [];
  const pitfalls = Array.isArray(receipt && receipt.pitfalls) ? receipt.pitfalls : [];
  if (!pitfalls.length) return { created, skipped };

  let entries = [];
  try {
    entries = loadKnowledge({ home, env }).entries;
  } catch {
    // 知识库不可读时仍然收候选：候选区自成一个目录，读失败不该让候选也丢
  }

  for (const pitfall of pitfalls) {
    const candidate = normalizeCandidate({
      scope: "pitfalls",
      title: pitfall && (pitfall.symptom || pitfall.title),
      trigger: pitfall && pitfall.trigger,
      body: [pitfall && pitfall.cause ? "原因：" + pitfall.cause : "", pitfall && pitfall.fix ? "解法：" + pitfall.fix : ""]
        .filter(Boolean)
        .join("\n"),
      source: "receipt",
      taskId: card.meta.id,
      project: card.meta.project,
    });

    const checked = validateCandidate(candidate);
    if (!checked.ok) {
      skipped.push({ title: candidate.title || "（无标题）", errors: checked.errors });
      continue;
    }

    const conflict = describeConflict(detectConflict(candidate, entries));
    const saved = saveCandidate({ home, env, candidate, conflict });
    if (saved.duplicate) {
      skipped.push({ title: candidate.title, errors: ["已有相同候选 " + saved.id] });
      continue;
    }

    appendEvent(home, {
      type: "memory.proposed",
      project: candidate.project,
      taskId: candidate.taskId,
      actor: "core",
      payload: { candidateId: saved.id, scope: candidate.scope, title: candidate.title, source: "receipt" },
    });
    created.push({ id: saved.id, title: candidate.title, conflict });
  }

  return { created, skipped };
}
