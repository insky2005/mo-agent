import fs from "node:fs";
import { MoError } from "../core/errors.mjs";
import { applyDecision, listRequests, readRequest } from "../cli/lib/approvals.mjs";
import { moHome } from "../cli/lib/paths.mjs";
import { listProjects } from "../cli/lib/project.mjs";
import { dispatchTask } from "../cli/lib/dispatch.mjs";
import { loadCard } from "../cli/lib/store.mjs";
import { cardSections, verifyItems } from "../core/tasks/card.mjs";
import { resolveDefaultWorker, resolveWorker } from "../cli/lib/workers-config.mjs";

/**
 * 任务卡确认请求的 host 侧入口：让手机/网页能点「允许 / 拒绝」。
 *
 * 请求文件是唯一真源（~/.mo-agent/approvals/）。这里只做两件事：
 * 列未决策的请求、把网页的点击变成 applyDecision。
 * 分层上暂时直接复用 cli/lib（与终端 approve 是同一份逻辑），
 * 以后 core/state 抽出来后这里换 import 即可。
 */

function rootFor(request, home) {
  if (request.projectRoot && fs.existsSync(request.projectRoot)) return request.projectRoot;
  const project = listProjects(home).find((item) => item.id === request.project);
  const root = project && (project.paths || []).find((candidate) => fs.existsSync(candidate));
  if (!root) {
    throw new MoError("E_PROJECT_MISSING", "找不到任务所在的项目目录：" + (request.project || "?"));
  }
  return root;
}

/** 卡的交付物与验收项：手机上要能看见"批的是什么"，读不到就退回空数组。 */
function cardSummary(item, home) {
  try {
    const root = rootFor(item, home);
    const card = loadCard(root, item.taskId);
    const sections = cardSections(card.body || "");
    const deliverables = String(sections["交付物"] || "")
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line && line !== "（未填写）");
    const verify = verifyItems(card.meta).map((raw) => {
      if (raw && typeof raw === "object") {
        const kind = ["run", "check", "human"].find((key) => raw[key] !== undefined);
        return kind ? kind + ": " + String(raw[kind]) : JSON.stringify(raw);
      }
      return String(raw);
    });
    return { deliverables, verify };
  } catch {
    return { deliverables: [], verify: [] };
  }
}

export function listTaskApprovals({ home = moHome() } = {}) {
  return listRequests(home)
    .filter((item) => item.status === "pending")
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      taskId: item.taskId,
      project: item.project,
      title: item.title,
      cardHash: item.cardHash,
      at: item.at,
      expiresAt: item.expiresAt,
      requestedBy: item.requestedBy || null,
      ...cardSummary(item, home),
    }));
}

export function decideTaskApproval({ home = moHome(), id, decision }) {
  if (!["approve", "reject"].includes(decision)) {
    throw new MoError("E_USAGE", "decision 只能是 approve 或 reject");
  }
  const request = readRequest(home, id);
  if (!request) throw new MoError("E_NOT_FOUND", "没有这个请求：" + id);
  if (request.status !== "pending") {
    throw new MoError("E_NOT_FOUND", "请求已经结束：" + request.status);
  }

  const root = rootFor(request, home);
  const decided = applyDecision({
    home,
    root,
    request,
    status: decision === "approve" ? "approved" : "rejected",
    channel: "web",
  });

  return { id: decided.id, status: decided.status, taskId: decided.taskId };
}

/** 卡上没写 exec 时按 worker/默认执行者解析命令（与 runDispatch 同一套规则）。 */
function resolveExec({ home, root, card }) {
  if (card.meta.exec) return String(card.meta.exec);
  const name = card.meta.worker || (card.meta.assignee !== "auto" ? card.meta.assignee : null);
  if (name) {
    const target = card.meta.session === undefined ? name + "-headless" : name;
    try {
      const worker = resolveWorker(target, { home, projectRoot: root });
      if (worker && worker.command) return worker.command;
    } catch {
      // 卡里的执行者已经不在了，退回默认执行者
    }
  }
  const fallback = resolveDefaultWorker({ home, projectRoot: root });
  return fallback && fallback.command ? fallback.command : null;
}

/**
 * 「批准并派单」（B3）：人的决定在手机上点完之后，不用再回终端敲 dispatch。
 *
 * 只接受已经 approved 的请求——批准本身仍然只能由人做；这里只是把
 * "批准之后那一步"从终端挪到了同一个点击里。runner 可注入，便于测试。
 */
export function dispatchApprovedTask(options = {}) {
  const home = options.home || moHome();
  const id = options.id;
  const log = options.log || { info() {}, warn() {} };
  const request = readRequest(home, id);
  if (!request) throw new MoError("E_NOT_FOUND", "没有这个请求：" + id);
  if (request.status !== "approved") {
    throw new MoError("E_NOT_CONFIRMED", "请求还没被批准（" + request.status + "），不能派单");
  }

  const root = rootFor(request, home);
  const card = loadCard(root, request.taskId);
  const exec = resolveExec({ home, root, card });
  if (!exec) {
    throw new MoError("E_NO_EXECUTOR", "这张卡没有执行者，也没有默认执行者", {
      hint: "先在终端 mo worker use <名称>，或 mo task dispatch " + request.taskId + " --exec '<命令>'",
    });
  }

  const runner = options.runner || dispatchTask;
  const taskId = request.taskId;
  // 后台跑：HTTP 立刻返回，结果照旧走 inbox / 手机通知
  Promise.resolve(runner({ home, root, taskId, exec, actor: "agent" }))
    .then((summary) => log.info("已按手机批准派单 " + taskId + " → " + (summary && summary.status)))
    .catch((error) => log.warn("按批准派单失败 " + taskId + "：" + (error && error.message ? error.message : error)));

  return { taskId, project: request.project, exec, started: true };
}
