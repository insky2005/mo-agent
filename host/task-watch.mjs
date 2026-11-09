import fs from "node:fs";
import path from "node:path";
import { EVENT } from "../core/contract.mjs";
import { moHome } from "../cli/lib/paths.mjs";
import { loadCard } from "../cli/lib/store.mjs";
import { cardSections, verifyItems } from "../core/tasks/card.mjs";

/**
 * 任务确认请求的提示器（B1）。
 *
 * 确认请求是 `~/.mo-agent/approvals/*.json` —— 一份文件队列，CLI 写完就没人知道了：
 * 它不进事件流、不触发推送，于是「手机亮起来批准任务卡」这条链一直是暗的。
 * host 常驻时把新出现的 pending 请求翻成一条 notice，手机/桌面才有人叫。
 *
 * 刻意只做"提示"：决定仍然只能由人做（/api/task-approvals 或 mo task approve）。
 *
 * 事件是正式的 `task.confirm_requested`（不是笼统的 notice），payload 带上交付物与
 * 验收项——手机端才能渲染成一张"看得见要批什么"的卡片，而不只是一行通知。
 */

const DEFAULT_INTERVAL_MS = 3000;
const MAX_SEEN = 500;

export function createTaskWatch(options = {}) {
  const home = options.home || moHome();
  const hub = options.hub || null;
  const log = options.log || { info() {}, warn() {} };
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
  const dir = path.join(home, "approvals");
  const seen = new Set();
  let timer = null;

  function readRequests() {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return []; // 目录还不存在：没人建过卡，属正常
    }
    const items = [];
    for (const name of names) {
      let item = null;
      try {
        item = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      } catch {
        continue; // 半截写入/坏文件：下一轮还会看到，不报错
      }
      if (item && item.id) items.push(item);
    }
    return items;
  }

  /** 卡片内容（交付物 / 验收项）：读不到就退回空数组，提示照发。 */
  function readCardDetails(item) {
    try {
      const root = item.projectRoot;
      if (!root) return { deliverables: [], verify: [] };
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

  function isExpired(item) {
    const at = Date.parse(item.expiresAt || "");
    return Number.isFinite(at) && at <= Date.now();
  }

  /** 扫一遍：返回这轮新发现的 pending 请求（已发过的不再返回）。 */
  function scan() {
    const fresh = [];
    for (const item of readRequests()) {
      if (item.status !== "pending") continue;
      if (seen.has(item.id)) continue;
      if (isExpired(item)) {
        seen.add(item.id); // 过期的不提示，但也不用每轮再看
        continue;
      }
      seen.add(item.id);
      fresh.push(item);

      const title = item.title || item.taskId || "任务卡";
      if (hub && typeof hub.emit === "function") {
        const details = readCardDetails(item);
        hub.emit(EVENT.TASK_CONFIRM_REQUESTED, {
          requestId: item.id,
          taskId: item.taskId || null,
          project: item.project || null,
          title,
          expiresAt: item.expiresAt || null,
          deliverables: details.deliverables,
          verify: details.verify,
        });
      }
      log.info("任务确认请求待批：" + title + "（请求 " + item.id + "）");
    }
    if (seen.size > MAX_SEEN) clear();
    return fresh;
  }

  function start() {
    if (timer) return scan();
    scan();
    timer = setInterval(() => {
      try {
        scan();
      } catch (error) {
        log.warn("扫描确认请求失败：" + (error && error.message ? error.message : error));
      }
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return [];
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function clear() {
    seen.clear();
  }

  return { scan, start, stop, clear, dir, seen };
}
