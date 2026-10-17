import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * whisper 对 0.5 秒左右的单词（"拒绝"）经常直接判成静音。
 * 前后各垫一段静音，短指令就稳了；长音频也不受影响。
 */
function findDataChunk(buffer) {
  for (let i = 12; i + 8 <= buffer.length; i++) {
    if (buffer[i] === 0x64 && buffer[i + 1] === 0x61 && buffer[i + 2] === 0x74 && buffer[i + 3] === 0x61) {
      return i;
    }
  }
  return -1;
}

async function padWav(file, seconds) {
  const buffer = await fs.readFile(file);
  const index = findDataChunk(buffer);
  if (index < 0) return file;
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  if (!channels || !sampleRate || !bits) return file;

  const header = Buffer.from(buffer.subarray(0, index + 8));
  const data = buffer.subarray(index + 8);
  const frameBytes = channels * (bits / 8);
  const silence = Buffer.alloc(Math.floor(sampleRate * (seconds || 1.2)) * frameBytes);
  const newData = Buffer.concat([silence, data, silence]);

  header.writeUInt32LE(header.length - 8 + newData.length, 4);
  header.writeUInt32LE(newData.length, index + 4);

  const padded = file.replace(/\.wav$/i, "-pad.wav");
  await fs.writeFile(padded, Buffer.concat([header, newData]));
  return padded;
}

/**
 * 本地 whisper.cpp 识别。不依赖任何云服务，也不需要系统「语音识别」权限。
 * 输出统一成 { ok, text, confidence }。
 */
export function createWhisperTranscriber(options) {
  const opts = options || {};
  const binary = opts.binary || ".build/bin/whisper-cli";
  const model = opts.model || ".build/models/ggml-small-q8_0.bin";
  const language = opts.language || "zh";
  const threads = String(opts.threads || 4);
  const log = opts.log || function () {};

  return async function transcribe(wavPath, options) {
    const started = Date.now();
    // 初始提示词只影响解码偏置，不改变音频；命令词表能显著减少同音字（会话 -> 绘画）。
    const prompt = String((options && options.prompt) || opts.prompt || "");
    let padded = wavPath;
    let stem = wavPath.replace(/\.wav$/i, "");
    let parsed = null;

    try {
      padded = await padWav(wavPath, opts.padSeconds || 1.2);
      stem = padded.replace(/\.wav$/i, "");
      const args = [
        "-m", model,
        "-f", padded,
        "-l", language,
        "-nt",
        "-np",
        "-ojf",
        "-of", stem,
        "-t", threads,
      ];
      if (prompt) args.push("--prompt", prompt);
      await execFileP(binary, args, {
        timeout: opts.timeoutMs || 120000,
        maxBuffer: 8 * 1024 * 1024,
      });
      parsed = JSON.parse(await fs.readFile(stem + ".json", "utf8"));
    } catch (error) {
      return {
        ok: false,
        error: "whisper-failed",
        message: String(error && error.message ? error.message : error),
      };
    } finally {
      if (padded !== wavPath) await fs.unlink(padded).catch(function () {});
      await fs.unlink(stem + ".json").catch(function () {});
    }

    const segments = Array.isArray(parsed.transcription) ? parsed.transcription : [];
    const text = segments.map(function (s) { return s.text || ""; }).join("").trim();
    const tokens = [];
    for (const segment of segments) {
      if (Array.isArray(segment.tokens)) tokens.push.apply(tokens, segment.tokens);
    }
    const probs = tokens
      .filter(function (t) { return t && typeof t.p === "number" && !String(t.text || "").startsWith("[_"); })
      .map(function (t) { return t.p; });
    const confidence = probs.length
      ? probs.reduce(function (a, b) { return a + b; }, 0) / probs.length
      : undefined;

    log({ type: "asr", text, confidence, ms: Date.now() - started });
    return { ok: true, text, confidence, ms: Date.now() - started };
  };
}
