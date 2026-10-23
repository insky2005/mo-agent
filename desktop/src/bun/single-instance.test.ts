// 运行：bun test desktop/src/bun/single-instance.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSingleInstance } from "./single-instance";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "mo-agent-single-"));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createSingleInstance", () => {
  test("第二个实例只写启动请求，不重复占锁", async () => {
    const dir = workspace();
    const lockPath = join(dir, "desktop.lock");
    const requestPath = join(dir, "desktop.launch");
    let launches = 0;

    const primary = createSingleInstance({ lockPath, requestPath, onLaunch: () => { launches += 1; } });
    expect(await primary.claim()).toBe(true);

    const secondary = createSingleInstance({ lockPath, requestPath, onLaunch: () => { launches += 1; } });
    expect(await secondary.claim()).toBe(false);
    expect(existsSync(requestPath)).toBe(true);

    await wait(500);
    expect(launches).toBe(1);
    expect(existsSync(requestPath)).toBe(false);

    secondary.release();
    primary.release();
    expect(existsSync(lockPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("上次崩溃留下的锁和请求不会阻止新实例", async () => {
    const dir = workspace();
    const lockPath = join(dir, "desktop.lock");
    const requestPath = join(dir, "desktop.launch");
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: "dead", startedAt: 1 }));
    writeFileSync(requestPath, "{}\n");
    let launches = 0;

    const instance = createSingleInstance({ lockPath, requestPath, onLaunch: () => { launches += 1; } });
    expect(await instance.claim()).toBe(true);

    const info = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(info.pid).toBe(process.pid);
    expect(info.token).not.toBe("dead");
    // 启动本身就会打开监控屏，遗留的请求应立即清掉，避免多弹一次。
    expect(existsSync(requestPath)).toBe(false);
    expect(launches).toBe(0);

    instance.release();
    rmSync(dir, { recursive: true, force: true });
  });

  test("release 不会删掉别的实例持有的锁", async () => {
    const dir = workspace();
    const lockPath = join(dir, "desktop.lock");
    const requestPath = join(dir, "desktop.launch");

    const instance = createSingleInstance({ lockPath, requestPath, onLaunch: () => {} });
    expect(await instance.claim()).toBe(true);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "other", startedAt: Date.now() }));

    instance.release();
    expect(existsSync(lockPath)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});
