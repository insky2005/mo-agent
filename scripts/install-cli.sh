#!/usr/bin/env bash
# 安装 mo CLI。
#   bash scripts/install-cli.sh            # 复用/构建单文件二进制，拷到 ~/.local/bin/mo
#   bash scripts/install-cli.sh --link     # 开发模式：软链到源码，改完立即生效
#   bash scripts/install-cli.sh --rebuild  # 强制重新构建
#   bash scripts/install-cli.sh --with-skill # 顺带安装 Agent 技能
#   bash scripts/install-cli.sh --no-completion
#   bash scripts/install-cli.sh --uninstall
#   MO_BIN_DIR=/opt/bin bash scripts/install-cli.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENTRY="$ROOT/cli/mo.mjs"
NAME="mo"
HOME_DIR="${MO_AGENT_HOME:-$HOME/.mo-agent}"
RECORD="$HOME_DIR/install.json"

BEGIN_MARK="# >>> mo completion >>>"
END_MARK="# <<< mo completion <<<"

MODE="binary"
UNINSTALL=0
REBUILD=0
WITH_SKILL=0
WANT_COMPLETION="auto"
WANT_SHELL="${MO_SHELL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --link) MODE="link" ;;
    --binary) MODE="binary" ;;
    --rebuild) REBUILD=1 ;;
    --with-skill) WITH_SKILL=1 ;;
    --no-completion) WANT_COMPLETION="none" ;;
    --completion) WANT_COMPLETION="yes"; shift; WANT_SHELL="${1:-}" ;;
    --completion=*) WANT_COMPLETION="yes"; WANT_SHELL="${1#--completion=}" ;;
    -h|--help)
      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
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
    echo "未识别的 shell：${shell}（跳过补全；可用 --completion zsh|bash 指定）"
    return 0
  fi
  [ -f "$rc" ] || touch "$rc"
  cp "$rc" "$rc.mo-agent.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  strip_block "$rc"
  block_body "$bin" "$shell" >> "$rc"
  echo "补全已写入：${rc}（${shell}）"
}

remove_completion() {
  for shell in zsh bash; do
    local rc
    rc="$(rc_for "$shell")"
    if [ -n "$rc" ] && [ -f "$rc" ] && grep -qF "$BEGIN_MARK" "$rc"; then
      strip_block "$rc"
      echo "已移除补全块：$rc"
    fi
  done
}

recorded_bin() {
  [ -f "$RECORD" ] || return 0
  grep '^bin=' "$RECORD" | head -1 | cut -d= -f2-
}

write_record() {
  local bin="$1" mode="$2"
  mkdir -p "$HOME_DIR"
  {
    echo "# mo 安装记录（scripts/install-cli.sh 写入）"
    echo "mode=$mode"
    echo "bin=$bin"
    echo "entry=$ENTRY"
    echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$RECORD"
}

uninstall_all() {
  local bin
  bin="$(recorded_bin)"
  if [ -n "$bin" ] && [ -e "$bin" ]; then
    rm -f "$bin"
    echo "已移除 $bin"
  fi
  for dir in "${MO_BIN_DIR:-}" "$HOME/.local/bin" "/usr/local/bin"; do
    [ -n "$dir" ] || continue
    if [ -L "$dir/$NAME" ] && [ "$(readlink "$dir/$NAME")" = "$ENTRY" ]; then
      rm -f "$dir/$NAME"
      echo "已移除 ${dir}/${NAME}（源码软链）"
    fi
  done
  remove_completion
  rm -f "$RECORD"
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

ARTIFACT="$ROOT/cli/dist/mo"

# 产物比这些输入新，就认为可以复用
# 产物能否在本机跑：防止交叉编译产物被当成可安装件
runnable() {
  "$ARTIFACT" --version >/dev/null 2>&1
}

is_stale() {
  [ -x "$ARTIFACT" ] || return 0
  if find "$ROOT/cli/mo.mjs" "$ROOT/cli/lib" "$ROOT/cli/commands" \
       "$ROOT/core/tasks" "$ROOT/core/errors.mjs" "$ROOT/package.json" \
       "$ROOT/scripts/build-cli.sh" -newer "$ARTIFACT" -type f 2>/dev/null | head -1 | grep -q .; then
    return 0
  fi
  return 1
}

SOURCE="$ENTRY"
if [ "$MODE" = "binary" ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "没有找到 bun，退化为源码软链（需要 Node，且依赖仓库路径不变）"
    echo "  想要单文件安装：brew install oven-sh/bun/bun 后重跑"
    MODE="link"
  elif [ "$REBUILD" = "0" ] && ! is_stale && runnable; then
    echo "复用已构建的 ${ARTIFACT}"
    SOURCE="$ARTIFACT"
  else
    echo "构建单文件二进制…"
    OUT_NAME="mo" bash "$ROOT/scripts/build-cli.sh" >/dev/null
    SOURCE="$ARTIFACT"
  fi
fi

CANDIDATES=()
[ -n "${MO_BIN_DIR:-}" ] && CANDIDATES+=("$MO_BIN_DIR")
CANDIDATES+=("$HOME/.local/bin" "/usr/local/bin")

INSTALLED=""
for dir in "${CANDIDATES[@]}"; do
  mkdir -p "$dir" 2>/dev/null || continue
  [ -w "$dir" ] || continue
  if [ "$MODE" = "link" ]; then
    ln -sf "$ENTRY" "$dir/$NAME"
  else
    install -m 0755 "$SOURCE" "$dir/$NAME"
  fi
  INSTALLED="$dir/$NAME"
  echo "已安装：${INSTALLED}（${MODE}）"
  break
done

if [ -z "$INSTALLED" ]; then
  echo "没有可写目录。用 MO_BIN_DIR=/某个在PATH里的目录 重试。" >&2
  exit 1
fi

write_record "$INSTALLED" "$MODE"

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
  remove_completion
fi

echo
"$INSTALLED" --version | sed 's/^/✓ mo /'

IN_PATH=0
case ":$PATH:" in
  *":$(dirname "$INSTALLED"):"*) IN_PATH=1 ;;
esac

NEED_SKILL=1
if [ "$WITH_SKILL" = "1" ] && [ -z "${MO_SKIP_SKILL:-}" ]; then
  if [ -t 0 ]; then
    "$INSTALLED" skill install || true
  else
    "$INSTALLED" skill install --yes || true
  fi
  NEED_SKILL=0
fi

if [ "$IN_PATH" = "0" ]; then
  echo
  printf 'PATH 未包含 %s，当前终端先执行：\n' "$(dirname "$INSTALLED")"
  printf '  export PATH="%s:$PATH"\n' "$(dirname "$INSTALLED")"
  echo "（要永久生效，把这一行加进你的 shell 配置）"
fi

if [ -n "$SHELL_NAME" ]; then
  echo
  echo "当前终端若要启用补全，请执行："
  printf '  hash -r; eval "$(%s completion %s)"\n' "$INSTALLED" "$SHELL_NAME"
fi

echo
echo "下一步："
if [ "$NEED_SKILL" = "1" ]; then
  echo "  mo skill install        给 Claude / Codex / Qoder 等安装 mo 技能（交互选择）"
fi
echo "  mo project init         在项目目录初始化 .mo-agent/ 并写入 Agent 说明"