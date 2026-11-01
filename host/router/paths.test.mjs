import test from "node:test";
import assert from "node:assert/strict";
import { credentialsFile, configDir, contractFile, routerFile, routerRoot, runtimeInstallDir, runtimeRoot, sessionsDir, workbenchDir } from "./paths.mjs";

const HOME = "/Users/x";

test("Router 的用户数据都在 ~/.mo-agent/router 下", () => {
  assert.equal(routerRoot(HOME), "/Users/x/.mo-agent/router");
  assert.equal(routerFile(HOME), "/Users/x/.mo-agent/router/router.json");
  assert.equal(credentialsFile(HOME), "/Users/x/.mo-agent/router/credentials.json");
  assert.equal(configDir(HOME), "/Users/x/.mo-agent/router/config");
  assert.equal(sessionsDir(HOME), "/Users/x/.mo-agent/router/sessions");
  assert.equal(workbenchDir(HOME), "/Users/x/.mo-agent/router/workbench");
  assert.equal(contractFile(HOME), "/Users/x/.mo-agent/router/workbench/ROUTER.md");
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
