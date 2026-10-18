import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles, createAdapters } from "./registry.mjs";
import { Hub } from "../core/hub.mjs";
import { EVENT_META, canonicalEventType } from "../core/contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const profilesDir = path.join(here, "profiles");
const profiles = loadProfiles(profilesDir);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const RUN_END = new Set(["explicit", "inferred", "none"]);
const OBSERVE = new Set(["process", "transcript", "native-api", "acp", "log"]);
const ATTENTION = new Set(["hook", "native", "derived", "none"]);
const APPROVAL = new Set(["allow", "deny", "none"]);

test("profile 能力声明合法", () => {
  assert.ok(profiles.length >= 1);
  for (const profile of profiles) {
    assert.ok(profile.id, "profile 缺 id");
    assert.ok(profile.label, profile.id + " 缺 label");
    if (profile.enabled === false) continue;
    const caps = profile.capabilities || {};
    assert.ok(RUN_END.has(caps.runEnd), profile.id + " runEnd 非法");
    assert.ok(ATTENTION.has(caps.attention), profile.id + " attention 非法");
    assert.ok(APPROVAL.has(caps.approval), profile.id + " approval 非法");
    for (const item of caps.observe || []) assert.ok(OBSERVE.has(item), profile.id + " observe 非法: " + item);
  }
});

test("profile 的 adapter 模块存在", () => {
  for (const profile of profiles) {
    if (profile.enabled === false || !profile.module) continue;
    const target = path.resolve(here, profile.module);
    assert.ok(fs.existsSync(target), profile.id + " 模块不存在: " + target);
  }
});

test("profile 的 hook 映射指向规范事件", () => {
  for (const profile of profiles) {
    const events = (profile.hooks && profile.hooks.events) || {};
    for (const [raw, mapped] of Object.entries(events)) {
      assert.ok(EVENT_META[mapped] || canonicalEventType(mapped), profile.id + " hook " + raw + " 映射非法: " + mapped);
    }
  }
});
test("registry 按 profile 动态加载 adapter", async () => {
  const hub = new Hub({ log: quiet });
  const dsh = { on() {}, listSessions: async () => ({ items: [] }) };
  const created = await createAdapters({
    hub,
    log: quiet,
    config: { pollMs: 1000, transcriptPollMs: 2000 },
    profiles,
    profilesDir,
    dsh,
  });
  const names = created.adapters.map((item) => item.name).sort();
  assert.deepEqual(names, ["claude-code", "dsh"]);
});
