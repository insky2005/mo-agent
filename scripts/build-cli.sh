#!/usr/bin/env bash
# 打单文件 CLI：bun --compile，产物不依赖 Node，也不需要源码。
#   bash scripts/build-cli.sh
#   TARGET=bun-linux-x64 bash scripts/build-cli.sh    # 交叉编译
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
TARGET="${TARGET:-}"

command -v bun >/dev/null 2>&1 || {
  echo "需要 bun：brew install oven-sh/bun/bun" >&2
  exit 1
}

VERSION="$(node -p "require('$ROOT/package.json').version")"
PLATFORM="${TARGET#bun-}"
[ -n "$PLATFORM" ] || PLATFORM="$(node -p 'process.platform + "-" + process.arch')"
OUT="$OUT_DIR/mo-$VERSION-$PLATFORM"

mkdir -p "$OUT_DIR"

ARGS=(build --compile --minify "$ROOT/cli/mo.mjs" --outfile "$OUT")
[ -n "$TARGET" ] && ARGS+=(--target "$TARGET")

bun "${ARGS[@]}"

echo "产物: $OUT ($(du -h "$OUT" | cut -f1))"
"$OUT" --version
