import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { synthesizeWav } from "./tts.mjs";
import { digitSequence } from "./text.mjs";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const p0 = path.join(here, "p0.mjs");
const binary = path.join(root, ".build", "bin", "whisper-cli");
const small = path.join(root, ".build", "models", "ggml-small-q8_0.bin");
const base = path.join(root, ".build", "models", "ggml-base.bin");
const usable = fs.existsSync(small) && fs.statSync(small).size > 50 * 1024 * 1024;
const model = usable ? small : base;
const ready = fs.existsSync(binary) && fs.existsSync(model);
const tmp = path.join(root, ".build", "voice-tmp");

test("P0 回放：TTS 音频 → whisper → 草稿 → 口令 → 真实 broker 放行", { skip: !ready }, async () => {
  fs.mkdirSync(tmp, { recursive: true });
  const wav = path.join(tmp, "e2e-nonce.wav");
  await synthesizeWav("四 七 二 九", wav);

  const result = await execFileP(process.execPath, [
    p0,
    "--mode", "replay",
    "--audio", wav,
    "--broker",
    "--nonce", "4729",
    "--dry-tts",
  ], { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 });

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.mode, "broker");
  assert.equal(parsed.outcome, "allow");
  assert.equal(parsed.decision, "allow_once");
  assert.equal(parsed.decided, true);
  assert.equal(digitSequence(parsed.heard[0].text), "4729");
});

test("P0 回放：拒绝音频 → reject_once", { skip: !ready }, async () => {
  fs.mkdirSync(tmp, { recursive: true });
  const wav = path.join(tmp, "e2e-reject.wav");
  await synthesizeWav("拒绝", wav);

  const result = await execFileP(process.execPath, [
    p0,
    "--mode", "replay",
    "--audio", wav,
    "--broker",
    "--nonce", "4729",
    "--dry-tts",
  ], { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 });

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.outcome, "reject");
  assert.equal(parsed.decision, "reject_once");
});
