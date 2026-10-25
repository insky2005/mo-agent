import fs from "node:fs";
import { MoError } from "../core/errors.mjs";
import { applyDecision, listRequests, readRequest } from "../cli/lib/approvals.mjs";
import { moHome } from "../cli/lib/paths.mjs";
import { listProjects } from "../cli/lib/project.mjs";

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
