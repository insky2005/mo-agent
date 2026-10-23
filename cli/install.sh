#!/usr/bin/env bash
# 安装 mo CLI：把一个 mo 软链放到 PATH 里的目录。
#   bash cli/install.sh                  # 自动选 ~/.local/bin 或 /usr/local/bin
#   bash cli/install.sh --uninstall      # 移除
#   MO_BIN_DIR=/some/dir bash cli/install.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENTRY="$ROOT/cli/mo.mjs"
NAME="mo"

if [ "${1:-}" = "--uninstall" ]; then
  for dir in "${MO_BIN_DIR:-}" "$HOME/.local/bin" "/usr/local/bin"; do
    [ -n "$dir" ] || continue
    if [ -L "$dir/$NAME" ] && [ "$(readlink "$dir/$NAME")" = "$ENTRY" ]; then
      rm -f "$dir/$NAME"
      echo "已移除 $dir/$NAME"
    fi
  done
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node 18+：找不到 node" >&2
  exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "需要 Node 18+，当前 $(node -v)" >&2
  exit 1
fi

chmod +x "$ENTRY"

CANDIDATES=()
[ -n "${MO_BIN_DIR:-}" ] && CANDIDATES+=("$MO_BIN_DIR")
CANDIDATES+=("$HOME/.local/bin" "/usr/local/bin")

for dir in "${CANDIDATES[@]}"; do
  mkdir -p "$dir" 2>/dev/null || continue
  [ -w "$dir" ] || continue
  ln -sf "$ENTRY" "$dir/$NAME"
  echo "已安装：$dir/$NAME -> $ENTRY"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "注意：$dir 不在 PATH 中，加进去并重开终端后才能直接敲 mo" ;;
  esac
  echo
  "$dir/$NAME" doctor || true
  echo
  echo "下一步：cd 到你的项目，执行 mo project add ."
  exit 0
done

echo "没有可写目录。用 MO_BIN_DIR=/某个在PATH里的目录 重试，或改用 npm link。" >&2
exit 1
