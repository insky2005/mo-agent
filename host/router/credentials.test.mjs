import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDER_ENV,
  buildEnv,
  deleteCredentials,
  providerEnvName,
  redactSecret,
  resolveCredentials,
  writeCredentials,
} from "./credentials.mjs";
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

test("写凭据：0600、可回读、只露后四位", () => {
  const home = tempHome();
  const written = writeCredentials(home, { provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-abcdefg9999" });
  assert.equal(written.redacted, "****9999");
  assert.equal(fs.statSync(credentialsFile(home)).mode & 0o777, 0o600);

  const raw = fs.readFileSync(credentialsFile(home), "utf8");
  assert.ok(raw.includes("sk-abcdefg9999"));

  const back = resolveCredentials(home, {});
  assert.equal(back.ok, true);
  assert.equal(back.source, "file");
  assert.equal(back.provider, "deepseek");

  assert.equal(deleteCredentials(home), true);
  assert.equal(fs.existsSync(credentialsFile(home)), false);
  assert.equal(resolveCredentials(home, {}).ok, false);
});

test("写凭据时缺 key 或不支持的 provider 都拒绝", () => {
  const home = tempHome();
  assert.throws(() => writeCredentials(home, { apiKey: "" }), (error) => error.code === "E_ROUTER_NO_CREDENTIAL");
  assert.throws(
    () => writeCredentials(home, { provider: "nope", apiKey: "sk-x" }),
    (error) => error.code === "E_ROUTER_NO_CREDENTIAL"
  );
});

test("不支持的 provider 明确报错", () => {
  const home = tempHome();
  const result = resolveCredentials(home, { MO_ROUTER_PROVIDER: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "E_ROUTER_NO_CREDENTIAL");
  assert.match(result.reason, /不支持的 provider/);
  assert.throws(() => buildEnv("nope", "x"), (error) => error.code === "E_ROUTER_NO_CREDENTIAL");
});
