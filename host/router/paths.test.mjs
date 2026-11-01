import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  configDir,
  contractFile,
  credentialsFile,
  moDataDir,
  routerFile,
  routerRoot,
  runtimeInstallDir,
  runtimeRoot,
  sessionsDir,
  workbenchDir,
} from "./paths.mjs";

const HOME = "/Users/x";
const DATA = "/Users/x/.mo-agent";

test("Router 的用户数据都在数据目录下的 router/", () => {
  assert.equal(routerRoot(DATA), "/Users/x/.mo-agent/router");
  assert.equal(routerFile(DATA), "/Users/x/.mo-agent/router/router.json");
  assert.equal(credentialsFile(DATA), "/Users/x/.mo-agent/router/credentials.json");
  assert.equal(configDir(DATA), "/Users/x/.mo-agent/router/config");
  assert.equal(sessionsDir(DATA), "/Users/x/.mo-agent/router/sessions");
  assert.equal(workbenchDir(DATA), "/Users/x/.mo-agent/router/workbench");
  assert.equal(contractFile(DATA), "/Users/x/.mo-agent/router/workbench/ROUTER.md");
  // dataDir 与 osHome 不能混：拼错一次就会得到 ~/.mo-agent/.mo-agent/router
  assert.ok(!routerRoot(DATA).includes(".mo-agent/.mo-agent"));
});

test("moDataDir 认 MO_AGENT_HOME，否则回落 ~/.mo-agent", () => {
  assert.equal(moDataDir({ MO_AGENT_HOME: "/tmp/alt" }), "/tmp/alt");
  assert.equal(moDataDir({}), path.join(os.homedir(), ".mo-agent"));
});

test("程序产物按平台落在 runtimeRoot 下，可用环境变量覆盖", () => {
  assert.equal(runtimeRoot({ home: HOME, platform: "darwin", env: {} }), "/Users/x/Library/Application Support/mo-agent");
  assert.equal(runtimeRoot({ home: HOME, platform: "linux", env: {} }), "/Users/x/.local/share/mo-agent");
  assert.equal(
    runtimeRoot({ home: HOME, platform: "linux", env: { XDG_DATA_HOME: "/data" } }),
    "/data/mo-agent"
  );
  assert.equal(
    runtimeRoot({ home: HOME, platform: "win32", env: { LOCALAPPDATA: "C:\\Local" } }),
    "C:\\Local/mo-agent"
  );
  assert.equal(
    runtimeRoot({ home: HOME, platform: "darwin", env: { MO_AGENT_RUNTIME_ROOT: "/opt/mo" } }),
    "/opt/mo"
  );
});

test("安装目录版本化：routers/<id>/<version>", () => {
  const dir = runtimeInstallDir({ home: HOME, platform: "darwin", env: {}, id: "pi", version: "1.3.0" });
  assert.equal(dir, "/Users/x/Library/Application Support/mo-agent/routers/pi/1.3.0");
});
