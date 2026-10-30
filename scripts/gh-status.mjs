#!/usr/bin/env node
// 看 GitHub 仓库与 CI 状态。token 只从本机读，不落仓库。
//
// 读取顺序：
//   1. 环境变量 GITHUB_TOKEN
//   2. macOS 钥匙串：security find-generic-password -s mo-agent-github-pat -w
//   3. ~/.config/mo-agent/github.token（0600）
//
//   node scripts/gh-status.mjs
//   GITHUB_REPO=owner/repo node scripts/gh-status.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.GITHUB_REPO || "insky2005/mo-agent";

function readToken() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, from: "环境变量 GITHUB_TOKEN" };

  if (process.platform === "darwin") {
    try {
      const token = execFileSync("security", ["find-generic-password", "-s", "mo-agent-github-pat", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (token) return { token, from: "钥匙串 mo-agent-github-pat" };
    } catch {
      // 没存就继续往下试
    }
  }

  const file = path.join(os.homedir(), ".config", "mo-agent", "github.token");
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token) return { token, from: file };
  } catch {
    // 没有这个文件
  }

  return null;
}

async function api(token, pathname) {
  const res = await fetch("https://api.github.com" + pathname, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mo-agent-gh-status",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(res.status + " " + pathname + " " + body.slice(0, 200));
  }
  return res.json();
}

function ago(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 60) return min + " 分钟前";
  const hour = Math.round(min / 60);
  if (hour < 48) return hour + " 小时前";
  return Math.round(hour / 24) + " 天前";
}

const found = readToken();
if (!found) {
  console.error("没有找到 GitHub token。任选一种方式存：");
  console.error("");
  console.error("  # 钥匙串（推荐）");
  console.error('  read -rsp "GitHub PAT: " PAT && echo && \\');
  console.error('  security add-generic-password -a "$USER" -s mo-agent-github-pat -w "$PAT" -U && unset PAT');
  console.error("");
  console.error("  # 或文件（0600，放在仓库外）");
  console.error("  mkdir -p ~/.config/mo-agent && chmod 700 ~/.config/mo-agent");
  console.error('  read -rsp "GitHub PAT: " PAT && echo && printf "%s" "$PAT" > ~/.config/mo-agent/github.token');
  console.error("  chmod 600 ~/.config/mo-agent/github.token && unset PAT");
  process.exit(1);
}

try {
  const repo = await api(found.token, "/repos/" + REPO);
  console.log("仓库    " + repo.full_name + (repo.private ? "（私有）" : "（公开）"));
  console.log("默认分支 " + repo.default_branch);
  console.log("大小    " + repo.size + " KB");
  console.log("推送时间 " + (repo.pushed_at ? ago(repo.pushed_at) : "从未"));
  if (repo.permissions) {
    console.log("权限    " + (repo.permissions.push ? "可写" : "只读"));
  }

  const branches = await api(found.token, "/repos/" + REPO + "/branches?per_page=20");
  console.log("\n分支    " + (branches.length ? branches.map((b) => b.name).join(", ") : "（空仓库）"));

  const runs = await api(found.token, "/repos/" + REPO + "/actions/runs?per_page=5");
  console.log("\n最近 CI " + (runs.total_count === 0 ? "还没有运行" : ""));
  for (const run of runs.workflow_runs || []) {
    console.log(
      "  " + (run.conclusion || run.status).padEnd(12) +
      run.name.padEnd(14).slice(0, 14) +
      (run.head_branch || "").padEnd(28).slice(0, 28) +
      ago(run.created_at) +
      "  " + run.html_url
    );
  }

  const pulls = await api(found.token, "/repos/" + REPO + "/pulls?state=open&per_page=10");
  console.log("\n开放 PR " + (pulls.length === 0 ? "（无）" : ""));
  for (const pr of pulls) {
    console.log(
      "  #" + String(pr.number).padEnd(5) +
      (pr.title || "").slice(0, 40).padEnd(42) +
      (pr.head.ref + " → " + pr.base.ref).padEnd(44).slice(0, 44) +
      ago(pr.created_at)
    );
  }

  // /issues 会把 PR 也列出来，按 pull_request 字段过滤掉
  const issues = (await api(found.token, "/repos/" + REPO + "/issues?state=open&per_page=20")).filter((i) => !i.pull_request);
  console.log("\n开放 issue " + (issues.length === 0 ? "（无）" : ""));
  for (const issue of issues.slice(0, 10)) {
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)).join(",");
    console.log(
      "  #" + String(issue.number).padEnd(5) +
      (issue.title || "").slice(0, 46).padEnd(48) +
      (labels || "-").padEnd(20).slice(0, 20) +
      ago(issue.created_at)
    );
  }

  console.log("\ntoken 来源：" + found.from);
} catch (error) {
  console.error("查询失败：" + error.message);
  if (/ 401 /.test(error.message)) console.error("token 失效了，重新生成一个");
  if (/ 403 /.test(error.message)) {
    console.error("权限不足。需要：Contents: Read（分支）、Actions: Read（CI）、Pull requests: Read（PR）、Issues: Read（issue）");
  }
  if (/ 404 /.test(error.message)) console.error("仓库不存在，或 token 没有该仓库的访问权");
  process.exit(1);
}
