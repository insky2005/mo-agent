/**
 * Router 运行时的版本清单。
 *
 * 必须是 .mjs、不能是 .json：单文件二进制（bun --compile）只会内联 JS 模块，
 * 运行时用 fs 读外部 JSON 会拿到 /$bunfs/... 一个不存在的路径。
 * 这条踩过：mo setup 里报 `运行时清单缺失：/$bunfs/root/runtimes.json`。
 *
 * 版本 pin 在这里，随 mo 版本走；不要改成 latest——运行时 CLI 契约会漂移。
 */
export const RUNTIMES = Object.freeze({
  pi: Object.freeze({
    package: "@earendil-works/pi-coding-agent",
    version: "1.3.0",
    bin: "dist/bundle/cli.js",
    engines: Object.freeze({ node: ">=22.19.0" }),
  }),
});

export function runtimeManifest(id) {
  return RUNTIMES[id || "pi"] || null;
}
