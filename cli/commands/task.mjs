import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { cardSections, renderCard, validateCard, verifyItems } from "../../core/tasks/card.mjs";
import { newTaskId } from "../lib/ids.mjs";
import { all, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome, cardPath } from "../lib/paths.mjs";
import { appendEvent, listCards, loadCard, readEvents, saveCard } from "../lib/store.mjs";
import { resolveProject } from "../lib/project.mjs";
import { dispatchTask } from "../lib/dispatch.mjs";
import { hasVerifyFailure, runVerify, verifyPayload } from "../lib/verify.mjs";
import { resolveWorker } from "../lib/workers-config.mjs";
import { transition } from "../lib/ingest.mjs";

function resolveContext(ctx, args) {
  return resolveProject({ cwd: ctx.cwd, target: one(args.options, "project"), home: moHome() });
}

/** --worker 与 --exec 二选一：前者用模板，后者是完整命令 */
function pickExecutor(options, ctx) {
  if (one(options, "agent") !== undefined) {
    throw new MoError("E_USAGE", "--agent 已改名为 --worker");
  }
  const workerName = one(options, "worker");
  const command = one(options, "exec");
  if (workerName && command) {
    throw new MoError("E_USAGE", "--worker 与 --exec 只能二选一");
  }
  if (workerName) return resolveWorker(workerName, ctx);
  return null;
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
  if (sub === "verify") return verifyTask(ctx, args, home);

  throw new MoError("E_USAGE", "未知子命令：task " + (sub || "") + "（可用：create / confirm / cancel / status / list / dispatch / verify）");
}

function createTask(ctx, args, home) {
  const resolved = resolveContext(ctx, args);
  const title = one(args.options, "title");
  if (!title) throw new MoError("E_USAGE", "缺少 --title");

  const deliverables = all(args.options, "deliverable");
  if (!deliverables.length) throw new MoError("E_USAGE", "缺少 --deliverable（至少一条交付物）");

  const verify = parseVerifyInput(all(args.options, "verify"));
  const chosen = pickExecutor(args.options, { home, projectRoot: resolved.root });
  if (chosen && !chosen.installed) {
    process.stderr.write("[W_WORKER_MISSING] " + chosen.binary + " 未安装，这张卡派单会失败\n");
  }
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
    worker: chosen ? chosen.name : undefined,
    exec: chosen ? chosen.command : one(args.options, "exec"),
    workdir: ".",
    verify,
    receipt,
    timeout: one(args.options, "timeout", "45m"),
    retries: 0,
    on_fail: "ask_human",
  };
  if (!verify.length) {
    process.stderr.write("[W_NO_VERIFY] 没有验收标准，完成后无法判定；加 --verify \"run:<命令>\" 或者 --verify \"check:<条件>\"\n");
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

  const cardFile = cardPath(resolved.root, id);
  const relativeCard = path.relative(resolved.root, cardFile);

  emit(args.options, { ok: true, taskId: id, status: meta.status, path: cardFile, project: resolved.root }, () =>
    [
      "✓ 已建卡（" + meta.status + "）",
      "",
      "  id     " + id,
      "  卡片   " + relativeCard,
      "  项目   " + resolved.root,
      "",
      "下一步（确认）：mo task confirm " + id,
    ].join("\n"));
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
  emit(args.options, { ok: true, taskId, status: next.meta.status }, () =>
    ["✓ 已确认", "", "  id     " + taskId, "  状态   " + next.meta.status, "", "下一步（派发）：mo task dispatch " + taskId].join("\n"));
  return 0;
}

function cancelTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  const next = transition({ home, root: resolved.root, card, to: "canceled", payload: { by: "human" } });
  emit(args.options, { ok: true, taskId, status: next.meta.status }, () =>
    ["✓ 已取消", "", "  id     " + taskId, "  状态   " + next.meta.status].join("\n"));
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
      "",
      "  项目   " + card.meta.project + "  (" + resolved.root + ")",
      "  验收   " + (payload.verify.length ? payload.verify.length + " 项 · " + payload.verified : "无"),
      "",
      "  最近事件",
      ...events.map((event) => "    " + event.at + "  " + event.type),
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


/**
 * 对已 done 的卡重跑验收：只更新 verified 与账本，不改状态。
 * 用于执行者说 done、但人想复核；失败时建议取消或重派。
 */
function verifyTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  if (card.meta.status !== "done") {
    throw new MoError("E_NOT_DONE", "只有 done 的卡能重跑验收，当前状态是 " + card.meta.status, {
      hint: "派单时会自动验收；卡在 blocked 时先 mo task dispatch 重试",
    });
  }

  const outcome = runVerify({ card, root: resolved.root });
  if (!outcome.results.length) {
    throw new MoError("E_NO_VERIFY", "这张卡没有验收标准，无法重跑", {
      hint: "建卡时用 --verify \"run:<命令>\" / \"check:<条件>\" / \"human:<说明>\" 补上",
    });
  }

  let verified = "unverified";
  let eventType = null;
  if (outcome.ok) {
    verified = "verified";
    eventType = "task.verified";
  } else if (hasVerifyFailure(outcome.results)) {
    verified = "verify_failed";
    eventType = "task.verify_failed";
  }

  card.meta.verified = verified;
  card.meta.updated = new Date().toISOString();
  saveCard(resolved.root, card.meta, card.body);
  if (eventType) {
    appendEvent(home, { type: eventType, project: card.meta.project, taskId, payload: verifyPayload(outcome) });
  }

  const failed = outcome.results.filter((result) => !result.ok && result.kind !== "human" && result.kind !== "unknown");
  emit(
    args.options,
    { ok: outcome.ok, taskId, status: card.meta.status, verified, verify: outcome },
    () => {
      const lines = [
        outcome.ok ? "✓ 验收通过" : "⚠ 验收未通过",
        "",
        "  id     " + taskId,
        "  验收   " + verifyLabel(outcome),
        "",
        ...outcome.results.map((result) => "  " + (result.ok ? "✓" : result.kind === "human" || result.kind === "unknown" ? "?" : "✗") + " " + result.item + (result.detail ? "  — " + result.detail : "")),
      ];
      if (failed.length) {
        lines.push("", "建议取消或重派：mo task cancel " + taskId + " / mo task dispatch " + taskId);
      } else if (!outcome.ok) {
        lines.push("", "需要人工确认后才能算完成。");
      }
      return lines.join("\n");
    },
  );
  return outcome.ok ? 0 : 1;
}

function verifyLabel(outcome) {
  const total = outcome.results.length;
  const passed = outcome.results.filter((result) => result.ok).length;
  if (!total) return "unverified";
  if (outcome.ok) return "verified " + passed + "/" + total;
  const failed = outcome.results.filter((result) => !result.ok && result.kind !== "human" && result.kind !== "unknown").length;
  if (failed) return "失败 " + failed + "/" + total;
  return "需人工确认 " + (total - passed) + "/" + total;
}

function dispatchCommand(ctx, args, home) {
  const resolved = resolveContext(ctx, args);
  const taskId = args.positional[1] || one(args.options, "task");
  if (!taskId) throw new MoError("E_USAGE", "缺少 taskId");
  return runDispatch(args, { home, root: resolved.root, taskId });
}

export function runDispatch(args, { home, root, taskId }) {
  const chosen = pickExecutor(args.options, { home, projectRoot: root });
  if (chosen && !chosen.installed) {
    throw new MoError("E_ASSIGNEE_UNSUPPORTED", "执行者 " + chosen.binary + " 未安装", {
      hint: "先装好它，或换一个 --worker / 用 --exec",
    });
  }
  return dispatchTask({
    home,
    root,
    taskId,
    exec: chosen ? chosen.command : one(args.options, "exec"),
    timeout: one(args.options, "timeout"),
  }).then((result) => {
    emit(args.options, { ok: result.status === "done", ...result }, () => {
      const head = {
        done: "✓ 已派发",
        blocked: "⚠ 已阻塞",
        failed: "✗ 已失败",
        canceled: "✗ 已取消",
      }[result.status] || "✓ " + result.status;

      const lines = [
        head,
        "",
        "  id     " + taskId,
        "  状态   " + result.status,
        "  执行者 " + (result.executor || "-"),
        "  验收   " + (result.verify && result.verify.results.length ? verifyLabel(result.verify) : result.verified),
      ];

      if (result.receipt && result.receipt.summary) lines.push("  结论   " + result.receipt.summary);
      if (result.reason && result.reason !== "receipt") lines.push("  原因   " + result.reason);
      if (result.exitCode !== undefined && result.exitCode !== null) lines.push("  退出码 " + result.exitCode);
      if (result.errors) lines.push("  问题   " + result.errors.join("；"));
      if (result.receiptFile) lines.push("  回执   " + path.relative(root, result.receiptFile));

      const failedItems = ((result.verify && result.verify.results) || []).filter((entry) => !entry.ok);
      if (failedItems.length) {
        lines.push("");
        for (const item of failedItems) {
          const mark = item.kind === "human" || item.kind === "unknown" ? "?" : "✗";
          lines.push("  " + mark + " " + item.item + (item.detail ? "  — " + item.detail : ""));
        }
      }

      if (result.outputTail) {
        lines.push("", "  输出");
        for (const line of String(result.outputTail).split("\n").slice(-8)) lines.push("    " + line);
      }

      return lines.join("\n");
    });
    return result.status === "done" ? 0 : 1;
  });
}