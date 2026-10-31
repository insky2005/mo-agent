/**
 * CLI 版本号。
 *
 * 单独放一个文件，是为了让 bun --compile 出来的单文件二进制也能报出版本：
 * 编译后没有 package.json 可读，必须把版本内联进代码。
 * scripts/check-version.mjs 会校验它和 package.json 一致。
 */
export const VERSION = "0.2.1";
