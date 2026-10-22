import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 本地计次：local（本机实际调用）+ billable（平台 Webhook & Stream 计费口径）。
 *
 * 按 channel 隔离，默认落 ~/.mo-agent/usage.json（0600）。
 * local 记录每一次 HTTP / Stream 事件 / 建连，含失败与重试；
 * billable 只由调用方在“平台确认成功”后累加。
 */

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai
const DEFAULT_CHANNEL = "dingtalk-bot";
const DEFAULT_LIMIT = 3000;
const DEFAULT_RECENT = 200;
const DEFAULT_RETAIN_DAYS = 40;
const SAVE_DEBOUNCE_MS = 3000;

function pad(value) {
  return value < 10 ? "0" + value : String(value);
}

function monthKey(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1);
}

function dayKey(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return monthKey(ms) + "-" + pad(d.getUTCDate());
}

function emptyLocal() {
  return {
    total: 0,
    ok: 0,
    fail: 0,
    retries: 0,
    byApi: {},
    byCategory: {},
    bySource: {},
    days: {},
    recent: [],
    lastAt: null,
  };
}

function emptyBillable() {
  return {
    total: 0,
    byDirection: {},
    byKind: {},
    days: {},
    failures: 0,
    lastAt: null,
  };
}

function emptyChannel() {
  return { local: emptyLocal(), billable: emptyBillable() };
}

function bump(map, key) {
  const value = String(key || "unknown");
  map[value] = (map[value] || 0) + 1;
}

function pruneDays(days, retainDays, now) {
  const keys = Object.keys(days);
  if (keys.length <= retainDays) return;
  keys.sort();
  for (const key of keys.slice(0, keys.length - retainDays)) delete days[key];
}

function archiveName(file, month) {
  const dir = path.dirname(file);
  const base = path.basename(file, ".json");
  return path.join(dir, base + "-" + month + ".json");
}

export function createUsageStore(options) {
  const opts = options || {};
  const file = opts.file || path.join(os.homedir(), ".mo-agent", "usage.json");
  const channel = opts.channel || DEFAULT_CHANNEL;
  const limit = Number.isFinite(Number(opts.monthlyLimit)) ? Number(opts.monthlyLimit) : DEFAULT_LIMIT;
  const warnAt = Number.isFinite(Number(opts.warnAt)) ? Number(opts.warnAt) : 0.8;
  const confirmOnlyAt = Number.isFinite(Number(opts.confirmOnlyAt)) ? Number(opts.confirmOnlyAt) : 1;
  const hardStopAt = Number.isFinite(Number(opts.hardStopAt)) ? Number(opts.hardStopAt) : 1.2;
  const recentLimit = Number(opts.recentLimit) || DEFAULT_RECENT;
  const retainDays = Number(opts.retainDays) || DEFAULT_RETAIN_DAYS;
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const saveDebounceMs = Number.isFinite(Number(opts.saveDebounceMs)) ? Number(opts.saveDebounceMs) : SAVE_DEBOUNCE_MS;

  let data = null;
  let timer = null;
  let quotaExhausted = false;
  let quotaReason = null;

  function reset(at) {
    data = {
      version: 2,
      month: monthKey(at),
      timezone: "Asia/Shanghai",
      channels: { [channel]: emptyChannel() },
    };
  }

  function load() {
    const at = now();
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && parsed.version === 2 && parsed.channels) {
          data = parsed;
          if (data.month !== monthKey(at)) {
            const archived = archiveName(file, data.month);
            try {
              if (!fs.existsSync(archived)) fs.renameSync(file, archived);
            } catch (error) {
              log.warn("归档用量文件失败: " + (error && error.message ? error.message : error));
            }
            reset(at);
          }
        } else {
          reset(at);
        }
      } else {
        reset(at);
      }
    } catch (error) {
      log.warn("读取用量文件失败（" + file + "）: " + (error && error.message ? error.message : error));
      reset(at);
    }
    if (!data.channels[channel]) data.channels[channel] = emptyChannel();
    const ch = data.channels[channel];
    ch.local = Object.assign(emptyLocal(), ch.local || {});
    ch.billable = Object.assign(emptyBillable(), ch.billable || {});
    return data;
  }

  function channelData() {
    if (!data) load();
    if (data.month !== monthKey(now())) {
      reset(now());
    }
    if (!data.channels[channel]) data.channels[channel] = emptyChannel();
    return data.channels[channel];
  }

  function saveNow() {
    if (!data) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch (error) { /* ignore */ }
    } catch (error) {
      log.warn("保存用量文件失败: " + (error && error.message ? error.message : error));
    }
  }

  function scheduleSave() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      saveNow();
    }, saveDebounceMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function bumpBillable(entry, at) {
    const ch = channelData();
    const kind = entry.kind || "event";
    const direction = entry.direction || "in";
    ch.billable.total += 1;
    bump(ch.billable.byDirection, direction);
    bump(ch.billable.byKind, kind);
    const day = dayKey(at);
    ch.billable.days[day] = (ch.billable.days[day] || 0) + 1;
    pruneDays(ch.billable.days, retainDays, at);
    ch.billable.lastAt = at;
  }

  return {
    channel,

    record(entry) {
      const input = entry || {};
      const at = Number(input.at) || now();
      const ch = channelData();
      const api = String(input.api || "unknown");
      const category = String(input.category || "api");
      const source = String(input.source || "host");
      const ok = input.ok !== false;
      const retry = !!input.retry;

      ch.local.total += 1;
      if (ok) ch.local.ok += 1;
      else ch.local.fail += 1;
      if (retry) ch.local.retries += 1;
      bump(ch.local.byApi, api);
      bump(ch.local.byCategory, category);
      bump(ch.local.bySource, source);

      const day = dayKey(at);
      ch.local.days[day] = (ch.local.days[day] || 0) + 1;
      pruneDays(ch.local.days, retainDays, at);

      ch.local.recent.unshift({
        at,
        api,
        category,
        source,
        ok,
        ms: Number(input.ms) || 0,
        billable: !!input.billable,
        retry,
      });
      if (ch.local.recent.length > recentLimit) ch.local.recent.length = recentLimit;
      ch.local.lastAt = at;

      if (input.billable && ok) bumpBillable(input, at);
      if (input.billable && !ok) ch.billable.failures += 1;

      scheduleSave();
      return this;
    },

    /** 仅累加 billable，不重复本地计数（发送前已由 HTTP wrapper 记过 local）。 */
    recordBillable(entry) {
      const input = entry || {};
      const at = Number(input.at) || now();
      bumpBillable(input, at);
      scheduleSave();
      return this;
    },

    snapshot() {
      const ch = channelData();
      const at = now();
      const today = dayKey(at);
      const total = ch.billable.total;
      return {
        month: data.month,
        updatedAt: at,
        local: {
          total: ch.local.total,
          today: ch.local.days[today] || 0,
          ok: ch.local.ok,
          fail: ch.local.fail,
          retries: ch.local.retries,
          byApi: Object.assign({}, ch.local.byApi),
          byCategory: Object.assign({}, ch.local.byCategory),
          bySource: Object.assign({}, ch.local.bySource),
          recent: ch.local.recent.slice(0, recentLimit),
          lastAt: ch.local.lastAt,
        },
        billable: {
          total,
          limit,
          percent: limit > 0 ? total / limit : 0,
          today: ch.billable.days[today] || 0,
          byDirection: Object.assign({}, ch.billable.byDirection),
          byKind: Object.assign({}, ch.billable.byKind),
          failures: ch.billable.failures,
          lastAt: ch.billable.lastAt,
        },
        quotaExhausted,
        quotaReason,
        thresholds: { warnAt, confirmOnlyAt, hardStopAt },
      };
    },

    canSend(intent) {
      const requiresAction = !!(intent && intent.requiresAction);
      if (quotaExhausted) return { allow: false, reason: "quota-exhausted", percent: this.snapshot().billable.percent };
      const ch = channelData();
      const percent = limit > 0 ? ch.billable.total / limit : 0;
      if (percent >= hardStopAt) return { allow: false, reason: "hard-stop", percent };
      if (percent >= confirmOnlyAt && !requiresAction) return { allow: false, reason: "confirm-only", percent };
      return { allow: true, reason: null, percent };
    },

    markQuotaExhausted(reason) {
      quotaExhausted = true;
      quotaReason = reason || "quota";
      saveNow();
    },

    clearQuotaExhausted() {
      quotaExhausted = false;
      quotaReason = null;
      saveNow();
    },

    isQuotaExhausted() {
      return quotaExhausted;
    },

    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      saveNow();
    },
  };
}
