import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWhisperTranscriber } from "./whisper.mjs";
import { COMMAND_PROMPT } from "./commands.mjs";
import { synthesizeWav } from "./tts.mjs";
import { digitSequence, parseReply } from "./text.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const binary = path.join(root, ".build", "bin", "whisper-cli");
const small = path.join(root, ".build", "models", "ggml-small-q8_0.bin");
const base = path.join(root, ".build", "models", "ggml-base.bin");
const usable = fs.existsSync(small) && fs.statSync(small).size > 50 * 1024 * 1024;
const model = usable ? small : base;
const ready = fs.existsSync(binary) && fs.existsSync(model);
const tmp = path.join(root, ".build", "voice-tmp");

test("whisper 能识别人造口令音频（离线、无系统语音权限）", { skip: !ready }, async () => {
  fs.mkdirSync(tmp, { recursive: true });
  const wav = path.join(tmp, "test-nonce.wav");
  await synthesizeWav("四 七 二 九", wav);
  const transcribe = createWhisperTranscriber({ binary, model });
  const result = await transcribe(wav);
  assert.equal(result.ok, true);
  assert.equal(digitSequence(result.text), "4729");
});

test("whisper 能识别确认词", { skip: !ready }, async () => {
  fs.mkdirSync(tmp, { recursive: true });
  const wav = path.join(tmp, "test-confirm.wav");
  await synthesizeWav("确认发送", wav);
  const transcribe = createWhisperTranscriber({ binary, model });
  const result = await transcribe(wav);
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("确认"), "实际识别: " + result.text);
});

test("whisper：命令提示词把同音字拉回「会话」", { skip: !ready }, async () => {
  fs.mkdirSync(tmp, { recursive: true });
  const wav = path.join(tmp, "test-switch.wav");
  await synthesizeWav("切到第一个会话", wav);
  const transcribe = createWhisperTranscriber({ binary, model });
  const result = await transcribe(wav, { prompt: COMMAND_PROMPT });
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("会话"), "实际识别: " + result.text);
});

test("whisper 能识别拒绝词", { skip: !ready }, async () => {
  fs.mkdirSync(tmp, { recursive: true });
  const wav = path.join(tmp, "test-reject.wav");
  await synthesizeWav("拒绝", wav);
  const transcribe = createWhisperTranscriber({ binary, model });
  const result = await transcribe(wav);
  assert.equal(result.ok, true);
  assert.equal(parseReply(result.text).intent, "reject", "实际识别: " + result.text);
});
