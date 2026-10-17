import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * TTS：默认走 macOS 的 say。
 * 播报是阻塞的，而且串行执行——同一时间只让一句话出声，
 * 避免授权草稿和 critical 通知叠在一起听不清。
 */
export function createSpeaker(options) {
  const opts = options || {};
  const voice = opts.voice || process.env.MO_AGENT_VOICE || "Tingting";
  const rate = String(opts.rate || 180);
  const log = opts.log || function () {};
  // say 退出不代表耳机/扬声器已经把最后一个音放完；紧接着开麦会切音频路由
  // （蓝牙 A2DP -> HFP），尾巴就被吃掉了。留一点收尾时间再收音。
  // afplay 已经保证播完；这里只需要一点点余量让蓝牙缓冲排空。
  const settleMs = Number(opts.settleMs || process.env.MO_AGENT_TTS_SETTLE_MS || 150);
  let tail = Promise.resolve();

  function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.catch(function () {});
    return run;
  }

  if (opts.dryRun) {
    return function speak(text) {
      return enqueue(async function () {
        log({ type: "tts-dry", text: String(text) });
      });
    };
  }

  return function speak(text) {
    return enqueue(async function () {
      const content = String(text);
      log({ type: "tts", text: content });
      const tmp = path.join(os.tmpdir(), "mo-agent-tts-" + process.pid + "-" + Date.now() + ".aiff");

      // 先合成再 afplay：afplay 会阻塞到真正播完。
      // say 直接播时可能在音频还挂在系统队列里就退出，紧接着开麦切蓝牙路由，
      // 最后一个字（半个音节）就被切掉了。
      try {
        await execFileP(opts.sayPath || "say", ["-v", voice, "-r", rate, "-o", tmp, content], {
          timeout: opts.timeoutMs || 60000,
        });
      } catch (error) {
        log({ type: "tts-say-failed", message: String(error && error.message ? error.message : error) });
        await execFileP(opts.sayPath || "say", ["-v", voice, "-r", rate, content], {
          timeout: opts.timeoutMs || 60000,
        });
        return;
      }

      try {
        await execFileP("afplay", [tmp], { timeout: opts.timeoutMs || 120000 });
      } finally {
        await fs.unlink(tmp).catch(function () {});
      }

      if (settleMs > 0) {
        await new Promise(function (resolve) { setTimeout(resolve, settleMs); });
      }
    });
  };
}

/** 把一句话合成成 16k 单声道 WAV，供离线识别与回归测试用。 */
export async function synthesizeWav(text, outWav, options) {
  const opts = options || {};
  const voice = opts.voice || process.env.MO_AGENT_VOICE || "Tingting";
  const rate = String(opts.rate || 180);
  await fs.mkdir(path.dirname(outWav), { recursive: true });
  const aiff = outWav.replace(/\.wav$/i, ".aiff");
  await execFileP("say", ["-v", voice, "-r", rate, "-o", aiff, String(text)], {
    timeout: opts.timeoutMs || 60000,
  });
  await execFileP("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, outWav], {
    timeout: opts.timeoutMs || 60000,
  });
  await fs.unlink(aiff).catch(function () {});
  return outWav;
}
