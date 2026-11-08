import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirFrom } from "../cli/lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 首次启动时把仓库里的默认通知配置写到 ~/.mo-agent/notify.json。
 * 这样用户（包括其他安装者）不需要手写配置文件。
 * 已存在则不覆盖，避免冲掉用户自己的通道配置。
 */
/**
 * 读通知配置里的静音时段（D3）。没有配置就返回 null（= 不静音），
 * 老用户的 notify.json 不会因为升级而突然变安静。
 */
export function readQuietHours(options = {}) {
  const opts = options || {};
  const file = opts.file || path.join(dataDirFrom(os.homedir(), opts.env || process.env), "notify.json");
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const quietHours = config && config.quietHours;
    if (!quietHours || typeof quietHours !== "object") return null;
    return quietHours;
  } catch {
    return null;
  }
}

export function ensureNotifyConfig(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const target = opts.target || path.join(dataDirFrom(os.homedir(), opts.env || process.env), "notify.json");
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
