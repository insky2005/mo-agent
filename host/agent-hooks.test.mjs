import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHooksManager,
  expandHome,
  hookCommandFor,
  inspectProfile,
  isManagedHook,
  planInstall,
  planUninstall,
  settingsPathsFor,
} from "./agent-hooks.mjs";

const quiet = { info() {}, warn() {} };

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-agent-hooks-"));
  const home = path.join(dir, "home");
  const root = path.join(dir, "Runtime With Space");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, "approvals"), { recursive: true });
  fs.writeFileSync(path.join(root, "approvals", "hook-cli.mjs"), "// test stub\n");
  return { dir, home, root, settings: path.join(home, ".claude", "settings.json") };
}

function claudeProfile(overrides) {
  return Object.assign({
    id: "claude-code",
    label: "Claude Code",
    enabled: true,
    hooks: {
      kind: "claude-code",
      settingsFile: "~/.claude/settings.json",
      events: { PermissionRequest: "approval.pending", Notification: "notice" },
      labels: {
        PermissionRequest: "授权请求：手机可批准 / 拒绝",
        Notification: "通知：Agent 需要关注时推送提醒",
      },
    },
  }, overrides || {});
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function backups(home) {
  const dir = path.join(home, ".claude");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.includes(".mo-agent.bak-"));
}

test("expandHome: ~/ 展开，绝对路径保持不变", () => {
  assert.equal(expandHome("~/.claude/settings.json", "/tmp/h"), "/tmp/h/.claude/settings.json");
  assert.equal(expandHome("/etc/x.json", "/tmp/h"), "/etc/x.json");
});

test("首次安装：生成 settings.json，写入两条 hook 与超时", () => {
  const ws = makeWorkspace();
  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [claudeProfile()], log: quiet });
  const [result] = manager.apply({ agentId: "claude-code" });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.backupPath, null);

  const settings = read(ws.settings);
  const permission = settings.hooks.PermissionRequest[0].hooks[0];
  assert.equal(permission.type, "command");
  assert.equal(permission.timeout, 600);
  assert.match(permission.command, /event PermissionRequest claude-code$/);
  assert.ok(permission.command.includes('"' + path.join(ws.root, "approvals", "hook-cli.mjs") + '"'));
  const notice = settings.hooks.Notification[0].hooks[0];
  assert.equal(notice.timeout, 10);

  const status = manager.status()[0];
  assert.equal(status.installed, true);
  assert.equal(status.outdated, false);
  const permissionEvent = status.events.find((item) => item.event === "PermissionRequest");
  assert.equal(permissionEvent.label, "授权请求：手机可批准 / 拒绝");
  assert.equal(permissionEvent.timeout, 600);
  const noticeEvent = status.events.find((item) => item.event === "Notification");
  assert.equal(noticeEvent.timeout, 10);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("重复安装幂等：不重复写、不产生多余备份", () => {
  const ws = makeWorkspace();
  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [claudeProfile()], log: quiet });
  manager.apply({});
  const first = fs.readFileSync(ws.settings, "utf8");
  const count = backups(ws.home).length;
  const [second] = manager.apply({});
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(ws.settings, "utf8"), first);
  assert.equal(backups(ws.home).length, count);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("合并已有配置：保留其它事件/其它 hook，卸载后能还原", () => {
  const ws = makeWorkspace();
  const original = {
    model: "opus",
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo keep" }] }],
      PermissionRequest: [{ matcher: "Read", hooks: [{ type: "command", command: "echo other" }] }],
    },
  };
  fs.mkdirSync(path.dirname(ws.settings), { recursive: true });
  fs.writeFileSync(ws.settings, JSON.stringify(original, null, 2) + "\n");

  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [claudeProfile()], log: quiet });
  const [installed] = manager.apply({ agentId: "claude-code" });
  assert.equal(installed.ok, true);
  assert.equal(installed.changed, true);
  assert.ok(installed.backupPath && fs.existsSync(installed.backupPath));

  const afterInstall = read(ws.settings);
  assert.equal(afterInstall.model, "opus");
  assert.deepEqual(afterInstall.permissions, original.permissions);
  assert.deepEqual(afterInstall.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.equal(afterInstall.hooks.PermissionRequest.length, 2);
  assert.equal(afterInstall.hooks.PermissionRequest[0].hooks[0].command, "echo other");

  const [removed] = manager.apply({ agentId: "claude-code", action: "uninstall" });
  assert.equal(removed.ok, true);
  assert.equal(removed.changed, true);
  assert.deepEqual(read(ws.settings), original);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("路径变化时更新旧 hook，而不是再写一条", () => {
  const ws = makeWorkspace();
  const oldRoot = path.join(ws.dir, "old-runtime");
  const stale = {
    hooks: {
      PermissionRequest: [{
        matcher: "*",
        hooks: [{ type: "command", command: hookCommandFor({ root: oldRoot, agentId: "claude-code", event: "PermissionRequest" }), timeout: 1 }],
      }],
    },
  };
  fs.mkdirSync(path.dirname(ws.settings), { recursive: true });
  fs.writeFileSync(ws.settings, JSON.stringify(stale, null, 2));

  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [claudeProfile()], log: quiet });
  const before = manager.status()[0];
  assert.equal(before.installed, false);
  assert.equal(before.outdated, true);

  manager.apply({ agentId: "claude-code" });
  const settings = read(ws.settings);
  const hooks = settings.hooks.PermissionRequest.flatMap((group) => group.hooks);
  const managed = hooks.filter((hook) => isManagedHook(hook, "claude-code", "PermissionRequest"));
  assert.equal(managed.length, 1);
  assert.match(managed[0].command, new RegExp(ws.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(manager.status()[0].installed, true);
  assert.equal(manager.status()[0].outdated, false);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("坏 JSON / 结构不对：拒绝写入，文件保持不变", () => {
  const ws = makeWorkspace();
  fs.mkdirSync(path.dirname(ws.settings), { recursive: true });
  fs.writeFileSync(ws.settings, "{ not json ");
  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [claudeProfile()], log: quiet });
  const [bad] = manager.apply({ agentId: "claude-code" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不是合法 JSON/);
  assert.equal(fs.readFileSync(ws.settings, "utf8"), "{ not json ");
  assert.equal(backups(ws.home).length, 0);

  fs.writeFileSync(ws.settings, JSON.stringify({ hooks: { PermissionRequest: "oops" } }));
  const [shape] = manager.apply({ agentId: "claude-code" });
  assert.equal(shape.ok, false);
  assert.match(shape.error, /不是数组/);
  assert.deepEqual(read(ws.settings), { hooks: { PermissionRequest: "oops" } });
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("dry-run 只预览，不落盘", () => {
  const ws = makeWorkspace();
  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [claudeProfile()], log: quiet });
  const [preview] = manager.apply({ agentId: "claude-code", dryRun: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.changed, true);
  assert.ok(preview.preview.hooks.PermissionRequest);
  assert.equal(fs.existsSync(ws.settings), false);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("一键配置全部：只写支持的 Agent，其它标记为不支持/原生", () => {
  const ws = makeWorkspace();
  const profiles = [
    claudeProfile(),
    claudeProfile({ id: "codex", label: "Codex CLI", hooks: { kind: "codex" } }),
    claudeProfile({ id: "dsh", label: "DSH", hooks: { kind: "native", events: {} } }),
  ];
  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles, log: quiet });
  const results = manager.apply({ agentId: "all" });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "claude-code");
  assert.equal(results[0].ok, true);

  const status = manager.status();
  assert.equal(status.find((item) => item.id === "dsh").reason, "原生接入，不需要 hook 配置");
  assert.equal(status.find((item) => item.id === "codex").supported, false);

  const [unsupported] = manager.apply({ agentId: "codex" });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /暂不支持/);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("hook 入口缺失：拒绝写入并提示重新构建", () => {
  const ws = makeWorkspace();
  fs.rmSync(path.join(ws.root, "approvals", "hook-cli.mjs"));
  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [claudeProfile()], log: quiet });
  assert.equal(manager.status()[0].runnerMissing, true);
  const [result] = manager.apply({ agentId: "claude-code" });
  assert.equal(result.ok, false);
  assert.match(result.error, /hook 入口不存在/);
  assert.equal(fs.existsSync(ws.settings), false);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("软链接：写穿到真实文件，链接保持为链接", () => {
  const ws = makeWorkspace();
  const real = path.join(ws.dir, "dotfiles-claude-settings.json");
  fs.writeFileSync(real, JSON.stringify({ model: "opus" }, null, 2));
  fs.mkdirSync(path.dirname(ws.settings), { recursive: true });
  fs.symlinkSync(real, ws.settings);

  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [claudeProfile()], log: quiet });
  const [result] = manager.apply({ agentId: "claude-code" });
  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(ws.settings).isSymbolicLink(), true);
  assert.equal(read(real).model, "opus");
  assert.ok(read(real).hooks.PermissionRequest);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("纯函数 planInstall / planUninstall 不修改入参", () => {
  const profile = claudeProfile();
  const original = { hooks: { Notification: [{ matcher: "*", hooks: [{ type: "command", command: "echo x" }] }] } };
  const snapshot = JSON.parse(JSON.stringify(original));
  const installed = planInstall(original, { root: "/tmp/root", profile });
  assert.deepEqual(original, snapshot);
  assert.equal(installed.settings.hooks.Notification.length, 2);
  const removed = planUninstall(installed.settings, { profile });
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.settings, original);
});

function qoderProfile(overrides) {
  return Object.assign({
    id: "qoder-cn",
    label: "Qoder CN",
    enabled: true,
    hooks: {
      kind: "qoder-cn",
      settingsFile: "~/.qoder-cn/settings.json",
      settingsFiles: ["~/.qoder/settings.json"],
      events: { PermissionRequest: "approval.pending", Notification: "notice" },
    },
  }, overrides || {});
}

test("Qoder CN：一键配置同时写运行时目录和文档目录，卸载时两边都还原", () => {
  const ws = makeWorkspace();
  const primary = path.join(ws.home, ".qoder-cn", "settings.json");
  const secondary = path.join(ws.home, ".qoder", "settings.json");
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.writeFileSync(primary, JSON.stringify({ model: "qmodel" }, null, 2) + "\n");

  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [qoderProfile()], log: quiet });
  const [installed] = manager.apply({ agentId: "qoder-cn" });
  assert.equal(installed.ok, true);
  assert.equal(installed.changed, true);
  assert.deepEqual(installed.settingsPaths, [primary, secondary]);
  assert.equal(installed.backupPaths.length, 1, "只有已存在的文件需要备份");
  assert.ok(fs.existsSync(installed.backupPaths[0]));

  for (const file of [primary, secondary]) {
    const settings = read(file);
    const permission = settings.hooks.PermissionRequest[0].hooks[0];
    assert.match(permission.command, /event PermissionRequest qoder-cn$/);
    assert.equal(permission.timeout, 600);
    assert.equal(settings.hooks.Notification[0].hooks[0].timeout, 10);
  }
  assert.equal(read(primary).model, "qmodel", "其它配置原样保留");

  const status = manager.status()[0];
  assert.equal(status.supported, true);
  assert.equal(status.installed, true);
  assert.equal(status.settingsPath, primary);
  assert.deepEqual(status.settingsPaths, [primary, secondary]);
  assert.equal(status.events.every((event) => event.installed), true);

  const [removed] = manager.apply({ agentId: "qoder-cn", action: "uninstall" });
  assert.equal(removed.ok, true);
  assert.deepEqual(read(primary), { model: "qmodel" });
  assert.deepEqual(read(secondary), {});
  assert.equal(manager.status()[0].installed, false);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("Qoder CN：任何一个 settings 坏 JSON 都整体中止，另一份不会被写", () => {
  const ws = makeWorkspace();
  const primary = path.join(ws.home, ".qoder-cn", "settings.json");
  const secondary = path.join(ws.home, ".qoder", "settings.json");
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.mkdirSync(path.dirname(secondary), { recursive: true });
  fs.writeFileSync(primary, JSON.stringify({ ok: true }, null, 2));
  fs.writeFileSync(secondary, "{ broken ");

  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [qoderProfile()], log: quiet });
  const [result] = manager.apply({ agentId: "qoder-cn" });
  assert.equal(result.ok, false);
  assert.match(result.error, /不是合法 JSON/);
  assert.deepEqual(read(primary), { ok: true }, "好文件也不能先写");
  assert.equal(fs.readFileSync(secondary, "utf8"), "{ broken ");
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("Qoder CN：只装了一份时状态算未完成，再跑一次补齐", () => {
  const ws = makeWorkspace();
  const primary = path.join(ws.home, ".qoder-cn", "settings.json");
  const secondary = path.join(ws.home, ".qoder", "settings.json");
  const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [qoderProfile()], log: quiet });

  const [first] = manager.apply({ agentId: "qoder-cn" });
  assert.equal(first.ok, true);
  fs.rmSync(secondary);
  assert.equal(manager.status()[0].installed, false);
  assert.equal(manager.status()[0].events.find((event) => event.event === "PermissionRequest").installed, false);

  const [second] = manager.apply({ agentId: "qoder-cn" });
  assert.equal(second.changed, true);
  assert.equal(manager.status()[0].installed, true);
  fs.rmSync(ws.dir, { recursive: true, force: true });
});

test("settingsPathsFor：去重并保持主文件在前", () => {
  assert.deepEqual(
    settingsPathsFor(qoderProfile({ hooks: { kind: "qoder-cn", settingsFile: "~/.qoder-cn/settings.json", settingsFiles: ["~/.qoder-cn/settings.json", "~/.qoder/settings.json"] } }), "/tmp/h"),
    ["/tmp/h/.qoder-cn/settings.json", "/tmp/h/.qoder/settings.json"]
  );
});

test("写入失败：返回错误而不是抛异常（例如目录不可写）", () => {
  const ws = makeWorkspace();
  const primary = path.join(ws.home, ".qoder-cn", "settings.json");
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.writeFileSync(primary, JSON.stringify({ model: "qmodel" }, null, 2));
  fs.chmodSync(path.dirname(primary), 0o500);
  try {
    const manager = createHooksManager({ root: ws.root, home: ws.home, profiles: [qoderProfile()], log: quiet });
    const [result] = manager.apply({ agentId: "qoder-cn" });
    assert.equal(result.ok, false);
    assert.match(result.error, /写入失败/);
    assert.deepEqual(read(primary), { model: "qmodel" }, "文件保持原样");
  } finally {
    fs.chmodSync(path.dirname(primary), 0o700);
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});
