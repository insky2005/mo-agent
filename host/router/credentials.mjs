import fs from "node:fs";
import { MoError } from "../../core/errors.mjs";
import { ROUTER_ERROR } from "../../core/router.mjs";
import { readJsonSafe } from "./fsx.mjs";
import { credentialsFile } from "./paths.mjs";

/**
 * Router 的凭据：由 mo 持有，启动时通过环境变量注入运行时。
 * 凭据永不落进运行时的配置目录，也永不写进 router.json。
 * 见 docs/spec/router.md §7。
 */

export const DEFAULT_PROVIDER = "deepseek";
export const DEFAULT_MODEL = "deepseek-v4-flash";

/** provider -> 运行时可识别的环境变量 */
export const PROVIDER_ENV = Object.freeze({
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
});

export function providerEnvName(provider) {
  return PROVIDER_ENV[provider] || null;
}

/** 只露后四位：日志、界面、错误信息都用它 */
export function redactSecret(secret) {
  const value = String(secret || "");
  if (!value) return "";
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}

function readFileCredentials(home) {
  const value = readJsonSafe(credentialsFile(home), null);
  if (!value || typeof value !== "object") return null;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  if (!apiKey) return null;
  return {
    provider: String(value.provider || DEFAULT_PROVIDER),
    model: String(value.model || DEFAULT_MODEL),
    apiKey,
    source: "file",
  };
}

/**
 * 解析凭据：文件优先，其次环境变量。
 * @returns {{ok: true, provider: string, model: string, apiKey: string, source: string, env: Record<string,string>}
 *          | {ok: false, code: string, reason: string, provider: string}}
 */
export function resolveCredentials(home, env) {
  const source = env || process.env;
  const provider = String(source.MO_ROUTER_PROVIDER || "").trim() || DEFAULT_PROVIDER;
  const model = String(source.MO_ROUTER_MODEL || "").trim() || DEFAULT_MODEL;

  const fromFile = readFileCredentials(home);
  if (fromFile) {
    return {
      ok: true,
      ...fromFile,
      env: buildEnv(fromFile.provider, fromFile.apiKey),
    };
  }

  const envName = providerEnvName(provider);
  const apiKey = envName ? String(source[envName] || "").trim() : "";
  if (!envName || !apiKey) {
    return {
      ok: false,
      code: ROUTER_ERROR.NO_CREDENTIAL,
      provider,
      reason: envName
        ? "没有找到 " + provider + " 的凭据（" + envName + " 未设置，也没有 credentials.json）"
        : "不支持的 provider：" + provider,
    };
  }
  return { ok: true, provider, model, apiKey, source: "env", env: buildEnv(provider, apiKey) };
}

/** 把凭据投影成运行时认的环境变量；换运行时只改这一张表 */
export function buildEnv(provider, apiKey) {
  const name = providerEnvName(provider);
  if (!name) {
    throw new MoError(ROUTER_ERROR.NO_CREDENTIAL, "不支持的 provider：" + provider, {
      hint: "可用：" + Object.keys(PROVIDER_ENV).join(" / "),
    });
  }
  return { [name]: String(apiKey) };
}
