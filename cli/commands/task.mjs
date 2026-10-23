import { MoError } from "../../core/errors.mjs";
import { cardSections, renderCard, validateCard, verifyItems } from "../../core/tasks/card.mjs";
import { STATES } from "../../core/tasks/model.mjs";
import { newTaskId } from "../lib/ids.mjs";
import { all, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome, cardPath } from "../lib/paths.mjs";
import { appendEvent, listCards, loadCard, readEvents, saveCard } from "../lib/store.mjs";
import { resolveProject } from "../lib/project.mjs";
import { dispatchTask } from "../lib/dispatch.mjs";
import { transition } from "../lib/ingest.mjs";

function resolveContext(ctx, args) {
  return resolveProject({ cwd: ctx.cwd, target: one(args.options, "project"), home: moHome() });
}

function parseVerifyInput(values) {
  return values.map((raw) => {
    const [kind, ...rest] = String(raw).split(":");
    const value = rest.join(":").trim();
    if (kind === "run" && value) return { run: value };
    if (kind === "check" && value) return { check: value };
    if (kind === "human" && value) return { human: value };
    return { check: String(raw) };
  });
}

function buildBody({ background, deliverables, boundaries, constraints }) {
  const section = (title, items) => {
    if (!items.length) return "## " + title + "\n\n（未填写）\n";
    return "## " + title + "\n\n" + items.map((item) => "- " + item).join("\n") + "\n";
  };
  return [
    background ? "## 背景\n\n" + background + "\n" : "",
    section("交付物", deliverables),
    section("边界（不要做）", boundaries),
    section("约束", constraints),
  ].filter(Boolean).join("\n");
}

export function taskCommand(ctx, args) {
  const sub = args.positional[0];
  const home = moHome();

  if (sub === "create") return createTask(ctx, args, home);
  if (sub === "confirm") return confirmTask(ctx, args, home);
  if (sub === "cancel") return cancelTask(ctx, args, home);
  if (sub === "status") return statusTask(ctx, args, home);
  if (sub === "list") return listTask(ctx, args, home);
  if (sub === "dispatch") return dispatchCommand(ctx, args, home);

  throw new MoError("E_USAGE", "未知子命令：task " + (sub || "") + "（可用：create / confirm / cancel / status / list / dispatch）");
}

function createTask(ctx, args, home) {
  const resolved = resolveContext(ctx, args);
  const title = one(args.options, "title");
  if (!title) throw new MoError("E_USAGE", "缺少 --title");

  const deliverables = all(args.options, "deliverable");
  if (!deliverables.length) throw new MoError("E_USAGE", "缺少 --deliverable（至少一条交付物）");

  const verify = parseVerifyInput(all(args.options, "verify"));
  const id = newTaskId();
  const now = new Date().toISOString();
  const receipt = ".mo-agent/receipts/" + id + ".json";

  const meta = {
    id,
    project: resolved.meta.id,
    title,
    status: "draft",
    created: now,
    updated: now,
    from: "cli",
    assignee: one(args.options, "assignee", "auto"),
    exec: one(args.options, "exec"),
    workdir: ".",
    verify,
    receipt,
    timeout: one(args.options, "timeout", "45m"),
    retries: 0,
    on_fail: "ask_human",
  };
  if (!verify.length) {
    process.stderr.write("[W_NO_VERIFY] 没有验收标准，这张卡完成后无法判定\n");
  }

  const body = buildBody({
    background: one(args.options, "background"),
    deliverables,
    boundaries: all(args.options, "boundary"),
    constraints: all(args.options, "constraint"),
  });

  validateCard(meta);
  const text = renderCard({ meta, body });
  if (Buffer.byteLength(text, "utf8") > 8 * 1024) {
    throw new MoError("E_CARD_TOO_LARGE", "任务卡超过 8KB，请拆分");
  }
  saveCard(resolved.root, meta, body);
  appendEvent(home, { type: "task.created", project: meta.project, taskId: id, payload: { title } });

  emit(args.options, { ok: true, taskId: id, status: meta.status, path: cardPath(resolved.root, id), project: resolved.root }, () =>
    "已建卡 " + id + "（draft）\n  项目: " + resolved.root + "\n  卡片: " + cardPath(resolved.root, id) + "\n\n确认后可派发：mo task confirm " + id);
  return 0;
}

function loadTarget(ctx, args) {
  const resolved = resolveContext(ctx, args);
  const taskId = args.positional[1] || one(args.options, "task");
  if (!taskId) throw new MoError("E_USAGE", "缺少 taskId");
  return { resolved, taskId, card: loadCard(resolved.root, taskId) };
}

function confirmTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  const next = transition({ home, root: resolved.root, card, to: "confirmed", payload: { by: "human" } });
  emit(args.options, { ok: true, taskId, status: next.meta.status }, "已确认 " + taskId + " → confirmed\n可以派发：mo task dispatch " + taskId);
  return 0;
}

function cancelTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  const next = transition({ home, root: resolved.root, card, to: "canceled", payload: { by: "human" } });
  emit(args.options, { ok: true, taskId, status: next.meta.status }, "已取消 " + taskId);
  return 0;
}

function statusTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  const events = readEvents(home).filter((event) => event.taskId === taskId).slice(-8);
  const payload = {
    taskId,
    status: card.meta.status,
    verified: card.meta.verified || "unverified",
    title: card.meta.title,
    project: card.meta.project,
    root: resolved.root,
    verify: verifyItems(card.meta),
    events,
  };
  emit(args.options, payload, () =>
    [
      taskId + "  [" + card.meta.status + "]  " + card.meta.title,
      "项目: " + card.meta.project + "  (" + resolved.root + ")",
      "验收: " + (payload.verify.length ? payload.verify.length + " 项" : "无"),
      "状态: " + STATES.join(" / "),
      "",
      "最近事件:",
      ...events.map((event) => "  " + event.at + "  " + event.type),
    ].join("\n"));
  return 0;
}

function listTask(ctx, args) {
  const resolved = resolveContext(ctx, args);
  const cards = listCards(resolved.root);
  if (!cards.length) {
    emit(args.options, { tasks: [] }, "这个项目还没有任务卡");
    return 0;
  }
  const rows = cards.map((card) => [card.meta.id, card.meta.status, card.meta.title]);
  emit(args.options, { tasks: cards.map((card) => ({ id: card.meta.id, status: card.meta.status, title: card.meta.title })) }, () =>
    table(rows, ["id", "状态", "标题"]));
  return 0;
}

function dispatchCommand(ctx, args, home) {
  const resolved = resolveContext(ctx, args);
  const taskId = args.positional[1] || one(args.options, "task");
  if (!taskId) throw new MoError("E_USAGE", "缺少 taskId");
  return runDispatch(args, { home, root: resolved.root, taskId });
}

export function runDispatch(args, { home, root, taskId }) {
  return dispatchTask({
    home,
    root,
    taskId,
    exec: one(args.options, "exec"),
    timeout: one(args.options, "timeout"),
  }).then((result) => {
    emit(args.options, { ok: result.status === "done", ...result }, () => {
      const lines = [
        taskId + " → " + result.status,
        "验收: " + result.verified,
      ];
      if (result.receipt && result.receipt.summary) lines.push("结论: " + result.receipt.summary);
      if (result.reason && result.reason !== "receipt") lines.push("原因: " + result.reason);
      if (result.errors) lines.push("问题: " + result.errors.join("；"));
      if (result.receiptFile) lines.push("回执: " + result.receiptFile);
      return lines.join("\n");
    });
    return result.status === "done" ? 0 : 1;
  });
}
