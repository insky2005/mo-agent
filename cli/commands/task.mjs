import path from "node:path";
import { MoError } from "../../core/errors.mjs";
import { cardSections, renderCard, validateCard, verifyItems } from "../../core/tasks/card.mjs";
import { newTaskId } from "../lib/ids.mjs";
import { all, has, one } from "../lib/args.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome, cardPath } from "../lib/paths.mjs";
import { appendEvent, listCards, loadCard, readEvents, readReceipt, saveCard } from "../lib/store.mjs";
import { resolveProject } from "../lib/project.mjs";
import { dispatchTask } from "../lib/dispatch.mjs";
import { hasVerifyFailure, runVerify, verifyPayload } from "../lib/verify.mjs";
import { readRunLog } from "../lib/logs.mjs";
import { resolveWorker } from "../lib/workers-config.mjs";
import { transition } from "../lib/ingest.mjs";
import readline from "node:readline/promises";
import { applyDecision, expireOverdue, listRequests, pendingForTask, readRequest, requestConfirmation } from "../lib/approvals.mjs";
import { cardDigest } from "../../core/manager/approval.mjs";
import { parseDuration } from "../lib/envelope.mjs";

/** 默认不认领项目：读命令不该顺手创建 .mo-agent/project.json（只有建卡才认领） */
function resolveContext(ctx, args, options = {}) {
  return resolveProject({
    cwd: ctx.cwd,
    target: one(args.options, "project"),
    home: moHome(),
    autoAttach: false,
    ...options,
  });
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
  if (sub === "approve") return approveTask(ctx, args, home);
  if (sub === "reject") return rejectTask(ctx, args, home);
  if (sub === "requests") return requestsTask(ctx, args, home);
  if (sub === "cancel") return cancelTask(ctx, args, home);
  if (sub === "status") return statusTask(ctx, args, home);
  if (sub === "list") return listTask(ctx, args, home);
  if (sub === "dispatch") return dispatchCommand(ctx, args, home);
  if (sub === "verify") return verifyTask(ctx, args, home);
  if (sub === "logs") return logsTask(ctx, args);

  throw new MoError("E_USAGE", "未知子命令：task " + (sub || "") + "（可用：create / confirm / approve / reject / requests / cancel / status / list / dispatch / verify / logs）");
}

function createTask(ctx, args, home) {
  const resolved = resolveContext(ctx, args, { autoAttach: true });
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
    from: one(args.options, "from") || process.env.MO_AGENT_ID || "cli",
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
  // CLI 发起的动作记为 agent（主 Agent）；core / worker 的事件由内核与执行者写入
  appendEvent(home, { type: "task.created", project: meta.project, taskId: id, payload: { title, from: meta.from }, actor: "agent" });

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

/**
 * 发起确认请求 —— 不是确认本身。
 * 确认权属于人：Agent 能发请求，批准必须走 mo task approve（终端）或手机。
 */
function confirmTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);

  if (card.meta.status === "confirmed") {
    emit(args.options, { ok: true, taskId, status: "confirmed", alreadyConfirmed: true }, () =>
      ["已经确认过了", "", "  id     " + taskId, "", "下一步（派发）：mo task dispatch " + taskId].join("\n"));
    return 0;
  }

  const { request, created } = requestConfirmation({
    home,
    root: resolved.root,
    card,
    requestedBy: { actor: "agent", from: one(args.options, "from") || process.env.MO_AGENT_ID || null },
    ttlMs: parseDuration(one(args.options, "ttl"), 24 * 60 * 60 * 1000),
  });

  if (has(args.options, "wait")) {
    return waitForApproval(ctx, args, home, resolved.root, taskId, request, parseDuration(one(args.options, "wait"), 30000));
  }

  emit(
    args.options,
    { ok: true, pending: true, taskId, title: card.meta.title, requestId: request.id, status: card.meta.status, expiresAt: request.expiresAt, created },
    () =>
      [
        "⏳ 已发出确认请求" + (created ? "" : "（复用未过期的请求）"),
        "",
        "  id     " + taskId,
        "  请求   " + request.id,
        "  标题   " + card.meta.title,
        "  过期   " + request.expiresAt,
        "",
        "确认权属于人：",
        "  终端：mo task approve " + taskId,
        "  手机：等推送后点「允许」",
        "",
        "批准前不会派单，卡仍是 draft。",
      ].join("\n"),
  );
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** mo task confirm --wait 60s：等决定出现 */
async function waitForApproval(ctx, args, home, root, taskId, request, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = "pending";
  while (Date.now() < deadline) {
    const current = readRequest(home, request.id);
    status = current ? current.status : "expired";
    if (status !== "pending") break;
    await sleep(500);
  }

  const card = loadCard(root, taskId);
  const approved = status === "approved" || card.meta.status === "confirmed";
  emit(
    args.options,
    { ok: approved, pending: !approved && status === "pending", taskId, requestId: request.id, status, cardStatus: card.meta.status },
    () =>
      approved
        ? ["✓ 已批准", "", "  id     " + taskId, "", "下一步（派发）：mo task dispatch " + taskId].join("\n")
        : ["⏳ 还没批准（" + status + "）", "", "  id     " + taskId, "  请求   " + request.id, "", "等用户批准后再继续。"].join("\n"),
  );
  return approved ? 0 : 1;
}

function requireTerminal(args) {
  if (process.stdin.isTTY) return true;
  if (has(args.options, "yes")) return false;
  throw new MoError("E_FORBIDDEN", "批准只能在人的终端里做（当前不是 TTY）", {
    hint: "让用户自己执行；CI 场景确实要的话加 --yes（会失去这道防线）",
  });
}

async function askYesNo(lines) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(lines.join("\n") + "\n> ");
    const answer = (await rl.question("")).trim().toLowerCase();
    return /^(y|yes|是)$/.test(answer);
  } finally {
    rl.close();
  }
}

/** mo task approve —— 人在终端批准；指纹不一致就作废 */
async function approveTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  const interactive = requireTerminal(args);

  const request = pendingForTask(home, taskId);
  if (!request) {
    if (card.meta.status === "confirmed") {
      emit(args.options, { ok: true, taskId, status: "confirmed", alreadyConfirmed: true }, "这张卡已经确认过了");
      return 0;
    }
    throw new MoError("E_NOT_FOUND", "没有待批准的请求", {
      hint: "先让主 Agent 发起：mo task confirm " + taskId,
    });
  }

  if (interactive) {
    const approved = await askYesNo([
      "要批准这张卡吗？",
      "",
      "  标题   " + card.meta.title,
      "  项目   " + card.meta.project,
      "  验收   " + (verifyItems(card.meta).length ? verifyItems(card.meta).length + " 项" : "无"),
      "  指纹   " + cardDigest(card).slice(0, 12) + "…",
      "  请求   " + request.id,
    ]);
    if (!approved) {
      applyDecision({ home, root: resolved.root, request, status: "rejected", channel: "terminal", note: "人在终端拒绝" });
      emit(args.options, { ok: false, taskId, status: "draft", rejected: true }, "已拒绝，卡保持 draft");
      return 1;
    }
  }

  const channel = String(one(args.options, "channel") || (interactive ? "terminal" : "cli-flag"));
  const decided = applyDecision({
    home,
    root: resolved.root,
    request,
    status: "approved",
    channel,
  });

  emit(
    args.options,
    { ok: true, taskId, status: "confirmed", requestId: decided.id, channel: decided.decidedBy.channel },
    () =>
      [
        "✓ 已确认",
        "",
        "  id     " + taskId,
        "  请求   " + decided.id,
        "  通道   " + decided.decidedBy.channel,
        "",
        "下一步（派发）：mo task dispatch " + taskId,
      ].join("\n"),
  );
  return 0;
}

/** mo task reject —— 人在终端拒绝，卡保持 draft */
function rejectTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  const interactive = requireTerminal(args);
  const request = pendingForTask(home, taskId);
  if (!request) {
    throw new MoError("E_NOT_FOUND", "没有待批准的请求", { hint: "mo task status " + taskId + " 看当前状态" });
  }
  const channel = String(one(args.options, "channel") || (interactive ? "terminal" : "cli-flag"));
  const decided = applyDecision({
    home,
    root: resolved.root,
    request,
    status: "rejected",
    channel,
    note: one(args.options, "note") || null,
  });
  emit(args.options, { ok: false, taskId, status: card.meta.status, requestId: decided.id, rejected: true }, () =>
    ["✗ 已拒绝", "", "  id     " + taskId, "  状态   " + card.meta.status, "  请求   " + decided.id].join("\n"));
  return 0;
}

/** mo task requests —— 看待批的确认请求（顺带清过期） */
function requestsTask(ctx, args, home) {
  let root = null;
  try {
    root = resolveProject({ cwd: ctx.cwd, home, autoAttach: false }).root;
  } catch {
    // 不在项目里也能看待批列表，只是没法顺手把过期卡置 expired
  }
  if (root) expireOverdue({ home, root });

  const pending = listRequests(home).filter((item) => item.status === "pending");
  emit(
    args.options,
    { ok: true, total: pending.length, requests: pending },
    () => {
      if (!pending.length) return "没有待批准的确认请求";
      const rows = pending.map((item) => [item.id, item.taskId, item.title, item.expiresAt]);
      return "待批准的确认请求（" + pending.length + " 条）\n\n" + table(rows, ["请求", "任务", "标题", "过期"]) + "\n\n批准：mo task approve <taskId>";
    },
  );
  return 0;
}

function cancelTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  const next = transition({ home, root: resolved.root, card, to: "canceled", payload: {}, actor: "agent" });
  emit(args.options, { ok: true, taskId, status: next.meta.status }, () =>
    ["✓ 已取消", "", "  id     " + taskId, "  状态   " + next.meta.status].join("\n"));
  return 0;
}

function statusTask(ctx, args, home) {
  const { resolved, taskId, card } = loadTarget(ctx, args);
  const events = readEvents(home).filter((event) => event.taskId === taskId).slice(-8);
  const pending = pendingForTask(home, taskId);

  // 最近一次回执：worker 的提问与偏差都在这里，不然回头看只剩一个 [blocked]
  const receipt = readReceipt(resolved.root, taskId);
  const lastReceipt =
    receipt && !receipt.__parseError
      ? {
          status: receipt.status || null,
          summary: receipt.summary || null,
          needs: Array.isArray(receipt.needs) ? receipt.needs : [],
          deviations: Array.isArray(receipt.deviations) ? receipt.deviations : [],
        }
      : null;
  const payload = {
    taskId,
    status: card.meta.status,
    verified: card.meta.verified || "unverified",
    title: card.meta.title,
    project: card.meta.project,
    root: resolved.root,
    verify: verifyItems(card.meta),
    ...(pending ? { approval: { requestId: pending.id, expiresAt: pending.expiresAt } } : {}),
    ...(lastReceipt ? { lastReceipt } : {}),
    events,
  };
  emit(args.options, payload, () =>
    [
      taskId + "  [" + card.meta.status + "]  " + card.meta.title,
      "",
      "  项目   " + card.meta.project + "  (" + resolved.root + ")",
      "  验收   " + (payload.verify.length ? payload.verify.length + " 项 · " + payload.verified : "无"),
      ...(pending ? ["  待批   " + pending.id + "   mo task approve " + taskId] : []),
      ...(lastReceipt && lastReceipt.summary ? ["  结论   " + lastReceipt.summary] : []),
      ...(lastReceipt && lastReceipt.needs.length
        ? ["  提问   " + lastReceipt.needs.map((item) => "· " + item).join("\n           ")]
        : []),
      ...(lastReceipt && lastReceipt.deviations.length
        ? ["  偏差   " + lastReceipt.deviations.map((item) => "· " + item).join("\n           ")]
        : []),
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
function logsTask(ctx, args) {
  const { resolved, taskId } = loadTarget(ctx, args);
  const found = readRunLog(resolved.root, taskId);
  if (!found) {
    throw new MoError("E_NOT_FOUND", "还没有这个任务的执行日志：" + taskId, {
      hint: "日志在派单时生成，先 mo task dispatch " + taskId,
    });
  }

  const tail = Number(one(args.options, "tail", "0"));
  const text = Number.isFinite(tail) && tail > 0 ? found.text.split("\n").slice(-tail).join("\n") : found.text;

  emit(args.options, { ok: true, taskId, path: path.relative(resolved.root, found.file), log: text }, () =>
    "── " + path.relative(resolved.root, found.file) + " ──\n" + text.replace(/\n$/, ""));
  return 0;
}

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

function nextStep(result, taskId) {
  // 只在需要动作时才提示；done 是终点，不再给"下一步"制造噪音
  if (result.status === "blocked") {
    return { label: "重试", command: "mo task dispatch " + taskId };
  }
  if (result.status === "failed") {
    return { label: "排查", command: "mo task status " + taskId };
  }
  return null;
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
    actor: "agent",
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

      if (result.knowledge && result.knowledge.count) {
        lines.push("  知识   " + result.knowledge.count + " 条（" + result.knowledge.ids.join(", ") + "）");
      }
      if (result.knowledge && result.knowledge.ok === false) lines.push("  知识   未注入（知识库不可读）");
      if (result.receipt && result.receipt.summary) lines.push("  结论   " + result.receipt.summary);
      if (result.receipt && Array.isArray(result.receipt.needs) && result.receipt.needs.length) {
        lines.push("  提问   " + result.receipt.needs.map((item) => "· " + item).join("\n           "));
      }
      if (result.receipt && Array.isArray(result.receipt.deviations) && result.receipt.deviations.length) {
        lines.push("  偏差   " + result.receipt.deviations.map((item) => "· " + item).join("\n           "));
      }
      if (result.reason && result.reason !== "receipt") lines.push("  原因   " + result.reason);
      if (result.exitCode !== undefined && result.exitCode !== null) lines.push("  退出码 " + result.exitCode);
      if (result.errors) lines.push("  问题   " + result.errors.join("；"));
      if (result.logFile) lines.push("  日志   " + path.relative(root, result.logFile));
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

      const next = nextStep(result, taskId);
      if (next) lines.push("", "下一步（" + next.label + "）：" + next.command);

      return lines.join("\n");
    });
    return result.status === "done" ? 0 : 1;
  });
}