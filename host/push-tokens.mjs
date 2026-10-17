import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 保存 App 上报的 HMS push token。
 * 放在 ~/.mo-agent/push-tokens.json，host 重启后仍能推送。
 */
export function createPushTokenStore(options) {
  const opts = options || {};
  const file = opts.file || path.join(os.homedir(), ".mo-agent", "push-tokens.json");
  const log = opts.log || (() => {});
  const tokens = new Set();

  try {
    if (fs.existsSync(file)) {
      const list = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(list)) for (const token of list) if (typeof token === "string" && token) tokens.add(token);
    }
  } catch (error) {
    log.warn("读取 push token 失败: " + (error && error.message ? error.message : error));
  }

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([...tokens]), { mode: 0o600 });
    } catch (error) {
      log.warn("保存 push token 失败: " + (error && error.message ? error.message : error));
    }
  };

  return {
    add(token) {
      const value = String(token || "").trim();
      if (value && !tokens.has(value)) {
        tokens.add(value);
        save();
      }
      return tokens.size;
    },
    remove(token) {
      if (tokens.delete(String(token || "").trim())) save();
    },
    list() {
      return [...tokens];
    },
    size() {
      return tokens.size;
    },
  };
}
