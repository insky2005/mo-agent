import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_ENV, buildEnv, providerEnvName, redactSecret, resolveCredentials } from "./credentials.mjs";
import { credentialsFile } from "./paths.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mo-router-cred-"));
}

test("provider 映射成运行时的环境变量名", () => {
  assert.equal(providerEnvName("deepseek"), "DEEPSEEK_API_KEY");
  assert.equal(providerEnvName("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(providerEnvName("openai"), "OPENAI_API_KEY");
  assert.equal(providerEnvName("nope"), null);
  assert.deepEqual(Object.keys(PROVIDER_ENV).sort(), ["anthropic", "deepseek", "openai"]);
});

test("脱敏只露后四位", () => {
  assert.equal(redactSecret("sk-abcdefgh1234"), "****1234");
  assert.equal(redactSecret("abc"), "****");
  assert.equal(redactSecret(""), "");
  assert.equal(redactSecret(null), "");
});

test("从环境变量取凭据（P1 路径）", () => {
  const home = tempHome();
  const result = resolveCredentials(home, { DEEPSEEK_API_KEY: "sk-test-0001" });
  assert.equal(result.ok, true);
  assert.equal(result.provider, DEFAULT_PROVIDER);
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(result.source, "env");
  assert.deepEqual(result.env, { DEEPSEEK_API_KEY: "sk-test-0001" });
});

test("文件凭据优先于环境变量", () => {
  const home = tempHome();
  fs.mkdirSync(path.dirname(credentialsFile(home)), { recursive: true });
  fs.writeFileSync(
    credentialsFile(home),
    JSON.stringify({ provider: "anthropic", model: "claude-x", apiKey: "sk-file" })
  );
  const result = resolveCredentials(home, { DEEPSEEK_API_KEY: "sk-env" });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "claude-x");
  assert.equal(result.source, "file");
  assert.deepEqual(result.env, { ANTHROPIC_API_KEY: "sk-file" });
});

test("没有凭据时给出稳定错误码，不静默启动", () => {
  const home = tempHome();
  const result = resolveCredentials(home, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "E_ROUTER_NO_CREDENTIAL");
  assert.match(result.reason, /DEEPSEEK_API_KEY/);
});

test("不支持的 provider 明确报错", () => {
  const home = tempHome();
  const result = resolveCredentials(home, { MO_ROUTER_PROVIDER: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "E_ROUTER_NO_CREDENTIAL");
  assert.match(result.reason, /不支持的 provider/);
  assert.throws(() => buildEnv("nope", "x"), (error) => error.code === "E_ROUTER_NO_CREDENTIAL");
});
