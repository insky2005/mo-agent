import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceNotifier } from "./notifier.mjs";

function makeSpeaker() {
  const said = [];
  return {
    said,
    speak: async function (text) { said.push(text); },
  };
}

test("critical 提问会念出来", async () => {
  const speaker = makeSpeaker();
  const notifier = createVoiceNotifier({ speaker: speaker.speak });
  await notifier.send({ severity: "critical", kind: "question", title: "Agent 正在询问", body: "选哪个分支" });
  assert.deepEqual(speaker.said, ["Agent 正在询问。选哪个分支"]);
});

test("失败会念出来", async () => {
  const speaker = makeSpeaker();
  const notifier = createVoiceNotifier({ speaker: speaker.speak });
  await notifier.send({ severity: "critical", kind: "error", title: "构建失败" });
  assert.deepEqual(speaker.said, ["构建失败"]);
});

test("授权不重复念，交给草稿流程", async () => {
  const speaker = makeSpeaker();
  const notifier = createVoiceNotifier({ speaker: speaker.speak });
  await notifier.send({ severity: "critical", kind: "approval", title: "需要授权", body: "Bash" });
  assert.equal(speaker.said.length, 0);
});

test("normal / info 不吵人", async () => {
  const speaker = makeSpeaker();
  const notifier = createVoiceNotifier({ speaker: speaker.speak });
  await notifier.send({ severity: "normal", kind: "completed", title: "完成" });
  await notifier.send({ severity: "info", kind: "notice", title: "提示" });
  assert.equal(speaker.said.length, 0);
});

test("speaker 抛错不影响通知通道", async () => {
  const warnings = [];
  const notifier = createVoiceNotifier({
    speaker: async function () { throw new Error("say 挂了"); },
    log: { warn: function (line) { warnings.push(line); } },
  });
  await notifier.send({ severity: "critical", kind: "error", title: "失败" });
  assert.ok(warnings[0].includes("say 挂了"));
});

test("静音时不播报", async () => {
  const speaker = makeSpeaker();
  const notifier = createVoiceNotifier({ speaker: speaker.speak, isMuted: function () { return true; } });
  await notifier.send({ severity: "critical", kind: "error", title: "失败" });
  assert.equal(speaker.said.length, 0);
});

test("取消静音后恢复播报", async () => {
  let muted = true;
  const speaker = makeSpeaker();
  const notifier = createVoiceNotifier({ speaker: speaker.speak, isMuted: function () { return muted; } });
  await notifier.send({ severity: "critical", kind: "error", title: "失败" });
  assert.equal(speaker.said.length, 0);
  muted = false;
  await notifier.send({ severity: "critical", kind: "error", title: "失败" });
  assert.deepEqual(speaker.said, ["失败"]);
});
