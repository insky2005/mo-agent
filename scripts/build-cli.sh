#!/usr/bin/env bash
# 打单文件 CLI：bun --compile，产物不依赖 Node，也不需要源码。
#
# 本地构建默认输出 cli/dist/mo —— 不带版本和平台：安装脚本只认这个路径，
# 版本用 mo --version 看。发布时才按平台重命名（CI 里传 OUT_NAME）。
#
#   bash scripts/build-cli.sh
#   TARGET=bun-linux-x64 bash scripts/build-cli.sh          # 交叉编译 → mo-linux-x64
#   OUT_NAME=mo-darwin-arm64 TARGET=bun-darwin-arm64 ...    # 发布产物
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/cli/dist}"
TARGET="${TARGET:-}"

command -v bun >/dev/null 2>&1 || {
  echo "需要 bun：brew install oven-sh/bun/bun" >&2
  exit 1
}

# 单文件二进制里内联的是 cli/lib/skill-content.mjs，它和 SKILL.md 都是生成物。
# 这里只校验、不生成：构建不应该悄悄改工作区。
node "$ROOT/scripts/gen-skill.mjs" --check

PLATFORM="${TARGET#bun-}"
[ -n "$PLATFORM" ] || PLATFORM="$(node -p 'process.platform + "-" + process.arch')"

if [ -n "${OUT_NAME:-}" ]; then
  NAME="$OUT_NAME"
elif [ -n "$TARGET" ]; then
  # 交叉编译不能占用本机入口名，否则会把 linux 产物装到 mac 上
  NAME="mo-$PLATFORM"
else
  NAME="mo"
fi
OUT="$OUT_DIR/$NAME"

mkdir -p "$OUT_DIR"

ARGS=(build --compile --minify "$ROOT/cli/mo.mjs" --outfile "$OUT")
[ -n "$TARGET" ] && ARGS+=(--target "$TARGET")

bun "${ARGS[@]}"

echo "产物: $OUT ($(du -h "$OUT" | cut -f1))"

HOST="bun-$(node -p 'process.platform + "-" + process.arch')"
if [ -z "$TARGET" ] || [ "$TARGET" = "$HOST" ]; then
  "$OUT" --version
else
  echo "（交叉编译产物，跳过本机执行验证）"
fi
