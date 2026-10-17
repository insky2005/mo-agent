import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 首次启动时把仓库里的默认通知配置写到 ~/.mo-agent/notify.json。
 * 这样用户（包括其他安装者）不需要手写配置文件。
 * 已存在则不覆盖，避免冲掉用户自己的通道配置。
 */
export function ensureNotifyConfig(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const target = opts.target || path.join(os.homedir(), ".mo-agent", "notify.json");
  const defaults = opts.defaults || path.join(here, "notify-defaults.json");

  try {
    if (fs.existsSync(target)) return false;
    if (!fs.existsSync(defaults)) return false;
    const content = fs.readFileSync(defaults, "utf8");
    JSON.parse(content); // 先校验，坏文件不要写出去
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode: 0o600 });
    log.info("已生成默认通知配置: " + target);
    return true;
  } catch (error) {
    log.warn("生成默认通知配置失败: " + (error && error.message ? error.message : error));
    return false;
  }
}
