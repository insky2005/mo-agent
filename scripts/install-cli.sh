#!/usr/bin/env bash
# 安装 mo CLI：软链到 PATH，并把 shell 补全写进 rc 文件。
#   bash scripts/install-cli.sh                   # 安装 + 补全
#   bash scripts/install-cli.sh --no-completion   # 只装命令
#   bash scripts/install-cli.sh --uninstall       # 卸载（含补全块）
#   MO_BIN_DIR=/opt/bin bash scripts/install-cli.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENTRY="$ROOT/cli/mo.mjs"
NAME="mo"

BEGIN_MARK="# >>> mo completion >>>"
END_MARK="# <<< mo completion <<<"

UNINSTALL=0
WANT_COMPLETION="auto"
WANT_SHELL="${MO_SHELL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --no-completion) WANT_COMPLETION="none" ;;
    --completion) WANT_COMPLETION="yes"; shift; WANT_SHELL="${1:-}" ;;
    --completion=*) WANT_COMPLETION="yes"; WANT_SHELL="${1#--completion=}" ;;
    -h|--help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

rc_for() {
  case "$1" in
    zsh) echo "$HOME/.zshrc" ;;
    bash) echo "$HOME/.bashrc" ;;
    *) echo "" ;;
  esac
}

detect_shell() {
  if [ -n "$WANT_SHELL" ]; then echo "$WANT_SHELL"; return; fi
  case "$(basename "${SHELL:-}")" in
    zsh) echo "zsh" ;;
    bash) echo "bash" ;;
    *) echo "" ;;
  esac
}

strip_block() {
  local file="$1"
  [ -f "$file" ] || return 0
  grep -qF "$BEGIN_MARK" "$file" || return 0
  local tmp="$file.mo-tmp-$$"
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    $0 == b {skip=1; next}
    $0 == e {skip=0; next}
    skip != 1 {print}
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

block_body() {
  local bin="$1" shell="$2"
  echo "$BEGIN_MARK"
  echo "# 由 scripts/install-cli.sh 写入；重装会更新这一段，删除本段即可关闭"
  echo "if [ -x \"$bin\" ]; then"
  if [ "$shell" = "zsh" ]; then
    echo "  if ! typeset -f compdef >/dev/null 2>&1; then autoload -Uz compinit && compinit -i; fi"
  fi
  echo "  eval \"\$(\"$bin\" completion $shell 2>/dev/null)\""
  echo "fi"
  echo "$END_MARK"
}

install_block() {
  local bin="$1" shell="$2"
  local rc
  rc="$(rc_for "$shell")"
  if [ -z "$rc" ]; then
    echo "未识别的 shell：$shell（跳过补全；可用 --completion zsh|bash 指定）"
    return 0
  fi
  [ -f "$rc" ] || touch "$rc"
  cp "$rc" "$rc.mo-agent.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  strip_block "$rc"
  block_body "$bin" "$shell" >> "$rc"
  echo "补全已写入：$rc（$shell）"
}

uninstall_all() {
  for dir in "${MO_BIN_DIR:-}" "$HOME/.local/bin" "/usr/local/bin"; do
    [ -n "$dir" ] || continue
    if [ -L "$dir/$NAME" ] && [ "$(readlink "$dir/$NAME")" = "$ENTRY" ]; then
      rm -f "$dir/$NAME"
      echo "已移除 $dir/$NAME"
    fi
  done
  for shell in zsh bash; do
    local rc
    rc="$(rc_for "$shell")"
    if [ -n "$rc" ] && [ -f "$rc" ] && grep -qF "$BEGIN_MARK" "$rc"; then
      strip_block "$rc"
      echo "已移除补全块：$rc"
    fi
  done
  exit 0
}

[ "$UNINSTALL" = "1" ] && uninstall_all

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

INSTALLED=""
for dir in "${CANDIDATES[@]}"; do
  mkdir -p "$dir" 2>/dev/null || continue
  [ -w "$dir" ] || continue
  ln -sf "$ENTRY" "$dir/$NAME"
  INSTALLED="$dir/$NAME"
  echo "已安装：$INSTALLED -> $ENTRY"
  break
done

if [ -z "$INSTALLED" ]; then
  echo "没有可写目录。用 MO_BIN_DIR=/某个在PATH里的目录 重试，或改用 npm link。" >&2
  exit 1
fi

case ":$PATH:" in
  *":$(dirname "$INSTALLED"):"*) ;;
  *) echo "注意：$(dirname "$INSTALLED") 不在 PATH 中，加进去并重开终端" ;;
esac

SHELL_NAME=""
if [ "$WANT_COMPLETION" = "auto" ]; then
  SHELL_NAME="$(detect_shell)"
  if [ -n "$SHELL_NAME" ]; then
    install_block "$INSTALLED" "$SHELL_NAME"
  else
    echo "未识别 shell（SHELL=${SHELL:-未设置}），跳过补全；可用 --completion zsh|bash"
  fi
elif [ "$WANT_COMPLETION" = "yes" ]; then
  SHELL_NAME="${WANT_SHELL:-zsh}"
  install_block "$INSTALLED" "$SHELL_NAME"
else
  # --no-completion：不仅不写，还把旧的块清掉
  for shell in zsh bash; do
    rc="$(rc_for "$shell")"
    if [ -n "$rc" ] && [ -f "$rc" ] && grep -qF "$BEGIN_MARK" "$rc"; then
      strip_block "$rc"
      echo "已移除补全块：$rc"
    fi
  done
fi

echo
"$INSTALLED" doctor || true
echo

IN_PATH=0
case ":$PATH:" in
  *":$(dirname "$INSTALLED"):"*) IN_PATH=1 ;;
esac

if [ "$IN_PATH" = "0" ]; then
  printf '当前终端先加 PATH（无需重开）：\n  export PATH="%s:$PATH"\n\n' "$(dirname "$INSTALLED")"
fi

if [ -n "$SHELL_NAME" ]; then
  printf '当前终端立刻启用补全（无需重开）：\n  hash -r 2>/dev/null; eval "$(%s completion %s)"\n\n' "$INSTALLED" "$SHELL_NAME"
fi

echo "下一步：cd 到你的项目，执行 mo project add ."
echo "新开的终端会自动生效；上面那行只用于当前这个终端。"