import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Agent hook 配置管理。
 *
 * 目标：把「手动合并 settings.snippet.json + 替换绝对路径」变成一次点击。
 * 只写自己认识的那几条 hook，其它配置原样保留；改之前先备份，坏 JSON 绝不覆盖。
 *
 * 只对 profile.hooks.kind 在 MANAGED_KINDS 里的 Agent 启用写入，
 * 其它厂商的 hooks 格式不猜（见 docs/research/domestic-agents-hooks.md）。
 *
 * 一个 Agent 可以声明多个 settings 文件（settingsFile + settingsFiles）：
 * 例如 Qoder CN 的运行时配置在 ~/.qoder-cn，但官方文档写的是 ~/.qoder，
 * 两处都写一份最稳，任何一份坏 JSON 都会整体中止，不会写一半。
 */

const HOOK_CLI_BASENAME = "hook-cli.mjs";
const DEFAULT_TIMEOUTS = { PermissionRequest: 600, Notification: 10 };
const MANAGED_KINDS = new Set(["claude-code", "qoder-cn"]);
const BACKUP_SUFFIX = ".mo-agent.bak-";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把 profile 里的 ~/ 路径展开成绝对路径。 */
export function expandHome(file, home) {
  const base = home || os.homedir();
  if (file === "~") return base;
  if (file.startsWith("~/")) return path.join(base, file.slice(2));
  return path.resolve(file);
}

/** 一个 Agent 要写的全部 settings 文件（去重、展开 ~）；主文件排第一。 */
export function settingsPathsFor(profile, home) {
  const hooks = (profile && profile.hooks) || {};
  const raw = [];
  if (typeof hooks.settingsFile === "string" && hooks.settingsFile) raw.push(hooks.settingsFile);
  if (Array.isArray(hooks.settingsFiles)) {
    for (const item of hooks.settingsFiles) {
      if (typeof item === "string" && item) raw.push(item);
    }
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const file = expandHome(item, home);
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

/** 主 settings 文件；兼容旧调用方。 */
export function settingsPathFor(profile, home) {
  return settingsPathsFor(profile, home)[0] || null;
}

/** mo-agent 写进 Agent 配置里的命令行。路径可能含空格，所以加引号。 */
export function hookCommandFor({ root, agentId, event }) {
  const cli = path.join(root, "approvals", HOOK_CLI_BASENAME);
  return 'node "' + cli + '" event ' + event + " " + agentId;
}

function eventPattern(agentId, event) {
  return new RegExp("(^|\\s)event\\s+" + escapeRegExp(event) + "\\s+" + escapeRegExp(agentId) + "(\\s|$)");
}

function agentPattern(agentId) {
  return new RegExp("(^|\\s)event\\s+\\S+\\s+" + escapeRegExp(agentId) + "(\\s|$)");
}

/** 这条 hook 是不是 mo-agent 为某个事件写的。 */
export function isManagedHook(hook, agentId, event) {
  if (!isPlainObject(hook) || hook.type !== "command" || typeof hook.command !== "string") return false;
  if (!hook.command.includes(HOOK_CLI_BASENAME)) return false;
  return eventPattern(agentId, event).test(hook.command);
}

/** 不论事件名，只要这条 hook 属于该 Agent 就归我们管（用于卸载旧事件）。 */
export function isManagedHookForAgent(hook, agentId) {
  if (!isPlainObject(hook) || hook.type !== "command" || typeof hook.command !== "string") return false;
  if (!hook.command.includes(HOOK_CLI_BASENAME)) return false;
  return agentPattern(agentId).test(hook.command);
}

export function timeoutFor(profile, event) {
  const configured = profile && profile.hooks && profile.hooks.timeouts && profile.hooks.timeouts[event];
  if (typeof configured === "number" && configured > 0) return configured;
  return DEFAULT_TIMEOUTS[event] || 30;
}

export function managedEvents(settings, profile) {
  const result = new Set();
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return result;
  const agentId = profile.id;
  for (const event of Object.keys(profile.hooks && profile.hooks.events ? profile.hooks.events : {})) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const found = groups.some((group) => isPlainObject(group)
      && Array.isArray(group.hooks)
      && group.hooks.some((hook) => isManagedHook(hook, agentId, event)));
    if (found) result.add(event);
  }
  return result;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { settings: {}, exists: false };
  const text = fs.readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const failure = new Error(file + " 不是合法 JSON，已停止（不会覆盖）：" + error.message);
    failure.code = "SETTINGS_PARSE_ERROR";
    throw failure;
  }
  if (!isPlainObject(parsed)) {
    const failure = new Error(file + " 的顶层不是对象，已停止（不会覆盖）");
    failure.code = "SETTINGS_PARSE_ERROR";
    throw failure;
  }
  return { settings: parsed, exists: true, text };
}

function assertHooksShape(settings, file) {
  if (settings.hooks === undefined) return;
  if (!isPlainObject(settings.hooks)) {
    throw new Error(file + " 的 hooks 字段不是对象，已停止（不会覆盖）");
  }
}

/** 纯函数：算出安装后的 settings，不碰磁盘。 */
export function planInstall(settings, { root, profile }) {
  const file = settingsPathFor(profile);
  assertHooksShape(settings, file || "settings.json");
  const next = clone(settings);
  const hooks = isPlainObject(next.hooks) ? next.hooks : {};
  const agentId = profile.id;
  const events = Object.keys((profile.hooks && profile.hooks.events) || {});
  const applied = [];

  for (const event of events) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error((file || "settings.json") + " 的 hooks." + event + " 不是数组，已停止（不会覆盖）");
    }
    const groups = Array.isArray(existing) ? existing : [];
    const kept = [];
    for (const group of groups) {
      if (!isPlainObject(group)) {
        kept.push(group);
        continue;
      }
      const inner = Array.isArray(group.hooks) ? group.hooks : [];
      const rest = inner.filter((hook) => !isManagedHook(hook, agentId, event));
      if (rest.length === inner.length) {
        kept.push(group);
        continue;
      }
      if (rest.length) kept.push(Object.assign({}, group, { hooks: rest }));
    }
    kept.push({
      matcher: "*",
      hooks: [{
        type: "command",
        command: hookCommandFor({ root, agentId, event }),
        timeout: timeoutFor(profile, event),
      }],
    });
    hooks[event] = kept;
    applied.push(event);
  }

  if (applied.length) next.hooks = hooks;
  return {
    settings: next,
    changed: JSON.stringify(next) !== JSON.stringify(settings),
    events: applied,
  };
}

/** 纯函数：只删 mo-agent 写入的 hook，其它事件与 matcher 原样保留。 */
export function planUninstall(settings, { profile }) {
  assertHooksShape(settings, profile && profile.hooks && profile.hooks.settingsFile);
  const next = clone(settings);
  if (!isPlainObject(next.hooks)) return { settings: next, changed: false, events: [] };
  const hooks = next.hooks;
  const removed = [];

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let eventChanged = false;
    const kept = [];
    for (const group of groups) {
      if (!isPlainObject(group)) {
        kept.push(group);
        continue;
      }
      const inner = Array.isArray(group.hooks) ? group.hooks : [];
      const rest = inner.filter((hook) => !isManagedHookForAgent(hook, profile.id));
      if (rest.length === inner.length) {
        kept.push(group);
        continue;
      }
      eventChanged = true;
      if (rest.length) kept.push(Object.assign({}, group, { hooks: rest }));
    }
    if (!eventChanged) continue;
    removed.push(event);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }

  if (!Object.keys(hooks).length) delete next.hooks;
  return {
    settings: next,
    changed: JSON.stringify(next) !== JSON.stringify(settings),
    events: removed,
  };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 写盘前把原文件复制一份；返回备份路径。 */
function backup(file, text) {
  const target = file + BACKUP_SUFFIX + stamp();
  fs.writeFileSync(target, text, { mode: 0o600 });
  return target;
}

function writeSettings(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch (error) {
    /* 权限没改也没关系 */
  }
}

/** 跟随软链，避免把 dotfiles 的链接替换成普通文件。 */
function writeTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    return file;
  }
}

/** 单个 settings 文件里的 hook 现状；坏文件不抛，交给调用方汇总。 */
function inspectSettingsFile(file, { root, profile }) {
  const hooks = (profile && profile.hooks) || {};
  const commandFor = (event) => hookCommandFor({ root, agentId: profile.id, event });
  let info;
  try {
    info = readSettings(file);
  } catch (error) {
    return { file, exists: true, error: error.message, managed: new Set(), events: [] };
  }
  const managed = info.exists ? managedEvents(info.settings, profile) : new Set();
  const events = Object.keys(hooks.events || {}).map((event) => {
    let current = null;
    const groups = info.exists && Array.isArray(info.settings.hooks && info.settings.hooks[event])
      ? info.settings.hooks[event]
      : [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      const hit = group.hooks.find((hook) => isManagedHook(hook, profile.id, event));
      if (hit) current = hit.command;
    }
    return { event, installed: managed.has(event), current, command: commandFor(event) };
  });
  return { file, exists: info.exists, error: null, managed, events };
}

/** 单个 Agent 的状态（可能跨多个 settings 文件）。 */
export function inspectProfile({ profile, root, home }) {
  const hooks = (profile && profile.hooks) || {};
  const kind = hooks.kind || "none";
  const settingsPaths = settingsPathsFor(profile, home);
  const settingsPath = settingsPaths[0] || null;
  const supported = MANAGED_KINDS.has(kind) && settingsPaths.length > 0;
  const cliPath = path.join(root, "approvals", HOOK_CLI_BASENAME);
  const base = {
    id: profile.id,
    label: profile.label || profile.id,
    enabled: profile.enabled !== false,
    kind,
    supported,
    settingsPath,
    settingsPaths,
    cliPath,
    runnerMissing: supported && !fs.existsSync(cliPath),
    exists: false,
    installed: false,
    outdated: false,
    events: [],
    files: [],
    error: null,
    reason: supported ? "" : (kind === "native" ? "原生接入，不需要 hook 配置" : "暂不支持一键配置"),
  };
  if (!supported) return base;

  const labels = hooks.labels || {};
  const files = settingsPaths.map((file) => inspectSettingsFile(file, { root, profile }));
  const failed = files.find((item) => item.error);
  if (failed) {
    return Object.assign({}, base, {
      exists: files.some((item) => item.exists),
      files: files.map((item) => ({ path: item.file, exists: item.exists, error: item.error })),
      error: failed.error,
    });
  }

  const desired = Object.keys(hooks.events || {});
  const events = desired.map((event) => {
    const perFile = files.map((item) => item.events.find((entry) => entry.event === event) || {});
    const command = hookCommandFor({ root, agentId: profile.id, event });
    return {
      event,
      label: typeof labels[event] === "string" ? labels[event] : "",
      timeout: timeoutFor(profile, event),
      installed: files.every((item) => item.managed.has(event)),
      command,
      current: perFile[0] ? perFile[0].current || null : null,
      outdated: perFile.some((entry) => entry.current && entry.current !== command),
      files: files.map((item, index) => ({
        path: item.file,
        installed: item.managed.has(event),
        current: perFile[index].current || null,
      })),
    };
  });
  const installed = desired.length > 0 && desired.every((event) => files.every((item) => item.managed.has(event)));
  return Object.assign({}, base, {
    exists: files.some((item) => item.exists),
    installed,
    outdated: events.some((item) => item.outdated),
    events,
    files: files.map((item) => ({ path: item.file, exists: item.exists, error: null })),
  });
}

/**
 * 配置管理器的门面：宿主和 CLI 共用同一套逻辑。
 *
 * apply({ agentId: "all" }) 只处理 enabled 且支持的 Agent；
 * 显式指定单个 Agent 时即使未启用也会执行（用户可能想先配好）。
 */
export function createHooksManager(options) {
  const opts = options || {};
  const root = opts.root || process.cwd();
  const home = opts.home || os.homedir();
  const profiles = Array.isArray(opts.profiles) ? opts.profiles : [];
  const log = opts.log || { info() {}, warn() {} };
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  const status = () => profiles.map((profile) => inspectProfile({ profile, root, home }));

  function applyOne(profile, action, dryRun) {
    const label = profile.label || profile.id;
    const settingsPaths = settingsPathsFor(profile, home);
    const settingsPath = settingsPaths[0] || null;
    const supported = MANAGED_KINDS.has(profile.hooks && profile.hooks.kind) && settingsPaths.length > 0;
    if (!supported) {
      return { id: profile.id, label, action, ok: false, error: "暂不支持一键配置" };
    }
    if (action !== "install" && action !== "uninstall") {
      return { id: profile.id, label, action, ok: false, error: "未知操作: " + action };
    }

    const cliPath = path.join(root, "approvals", HOOK_CLI_BASENAME);
    if (action === "install" && !fs.existsSync(cliPath)) {
      return {
        id: profile.id,
        label,
        action,
        ok: false,
        settingsPath,
        settingsPaths,
        error: "hook 入口不存在：" + cliPath + "（请重新构建/安装 mo-agent，或检查 MO_AGENT_ROOT）",
      };
    }

    // 先把所有文件读完、算完，再决定写不写：任何一个文件坏 JSON 都整体中止，避免写一半。
    const files = [];
    for (const file of settingsPaths) {
      const target = writeTarget(file);
      let info;
      try {
        info = readSettings(target);
      } catch (error) {
        return { id: profile.id, label, action, ok: false, settingsPath, settingsPaths, error: error.message };
      }
      let plan;
      try {
        plan = action === "uninstall"
          ? planUninstall(info.settings, { profile })
          : planInstall(info.settings, { root, profile });
      } catch (error) {
        return { id: profile.id, label, action, ok: false, settingsPath, settingsPaths, error: error.message };
      }
      files.push({ file, target, info, plan });
    }

    if (action === "uninstall" && !files.some((item) => item.info.exists)) {
      return { id: profile.id, label, action, ok: true, changed: false, settingsPath, settingsPaths, events: [], message: "配置文件不存在，无需卸载" };
    }

    const changed = files.filter((item) => item.plan.changed);
    const events = [...new Set(changed.flatMap((item) => item.plan.events))];
    if (!changed.length) {
      return { id: profile.id, label, action, ok: true, changed: false, settingsPath, settingsPaths, events, message: "已经是期望的配置" };
    }
    if (dryRun) {
      return {
        id: profile.id,
        label,
        action,
        ok: true,
        changed: true,
        dryRun: true,
        settingsPath,
        settingsPaths,
        events,
        preview: changed[0].plan.settings,
        previewFiles: changed.map((item) => item.file),
      };
    }

    const backupPaths = [];
    for (const item of changed) {
      try {
        const backupPath = item.info.exists ? backup(item.target, item.info.text) : null;
        if (backupPath) backupPaths.push(backupPath);
        writeSettings(item.target, item.plan.settings);
        log.info("Agent " + profile.id + " hook 配置已" + (action === "uninstall" ? "卸载" : "写入") + "：" + item.file + (backupPath ? "（备份 " + backupPath + "）" : ""));
      } catch (error) {
        return {
          id: profile.id,
          label,
          action,
          ok: false,
          settingsPath,
          settingsPaths,
          backupPaths,
          error: "写入失败（" + item.file + "）：" + error.message,
        };
      }
    }
    return {
      id: profile.id,
      label,
      action,
      ok: true,
      changed: true,
      settingsPath,
      settingsPaths,
      backupPath: backupPaths[0] || null,
      backupPaths,
      events,
      installed: inspectProfile({ profile, root, home }).installed,
    };
  }

  return {
    status,
    apply(request) {
      const input = request || {};
      const action = input.action === undefined ? "install" : input.action;
      if (action !== "install" && action !== "uninstall") {
        return [{ id: input.agentId || "all", label: input.agentId || "all", action, ok: false, error: "未知操作: " + action }];
      }
      const dryRun = input.dryRun === true;
      const agentId = input.agentId || "all";
      let targets;
      if (agentId === "all") {
        targets = profiles.filter((profile) => profile.enabled !== false && MANAGED_KINDS.has(profile.hooks && profile.hooks.kind));
      } else {
        const profile = byId.get(agentId);
        if (!profile) return [{ id: agentId, label: agentId, action, ok: false, error: "未知的 Agent: " + agentId }];
        targets = [profile];
      }
      if (!targets.length) {
        return [{ id: agentId, label: agentId, action, ok: false, error: "没有可配置的 Agent" }];
      }
      return targets.map((profile) => applyOne(profile, action, dryRun));
    },
  };
}
