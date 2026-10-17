import fs from "node:fs";
import path from "node:path";

// host.log 只追加会无限长大。这里按大小轮转，保留最近几份：
//   host.log 超过 maxBytes 时：host.log.N 丢掉，host.log.N-1 -> .N，host.log -> .1
// 只由 host 自己写，不再和桌面壳抢同一个文件。
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 3;

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    return 0;
  }
}

/**
 * 创建按大小轮转的追加型 sink。
 *
 * @param {object} options
 * @param {string} options.file       当前日志文件路径
 * @param {number} [options.maxBytes] 单文件上限，默认 5MB
 * @param {number} [options.keep]     保留几份历史文件，默认 3
 * @param {(error: Error) => void} [options.onError] 写失败回调（默认静默）
 */
export function createRotatingSink(options = {}) {
  const file = options.file;
  if (!file) throw new Error("createRotatingSink 需要 file");
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const keep = Number.isInteger(options.keep) && options.keep >= 0 ? options.keep : DEFAULT_KEEP;
  const dir = path.dirname(file);
  let size = sizeOf(file);
  let closed = false;

  function report(error) {
    if (typeof options.onError === "function") {
      try {
        options.onError(error);
      } catch (ignored) {
        /* 回调自己出错就不再传播 */
      }
    }
  }

  function rotate() {
    if (keep === 0) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        report(error);
      }
      size = 0;
      return;
    }
    try {
      fs.rmSync(file + "." + keep, { force: true });
    } catch (error) {
      report(error);
    }
    for (let index = keep - 1; index >= 1; index -= 1) {
      try {
        fs.renameSync(file + "." + index, file + "." + (index + 1));
      } catch (error) {
        // 中间几份可能还没生成
        if (!error || error.code !== "ENOENT") report(error);
      }
    }
    try {
      fs.renameSync(file, file + ".1");
    } catch (error) {
      if (!error || error.code !== "ENOENT") report(error);
    }
    size = 0;
  }

  return {
    file,
    get size() {
      return size;
    },
    write(chunk) {
      if (closed) return false;
      const text = typeof chunk === "string" ? chunk : String(chunk);
      const bytes = Buffer.byteLength(text);
      try {
        if (size > 0 && size + bytes > maxBytes) rotate();
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(file, text, "utf8");
        size += bytes;
        return true;
      } catch (error) {
        report(error);
        return false;
      }
    },
    close() {
      closed = true;
    },
  };
}
