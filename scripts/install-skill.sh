#!/usr/bin/env bash
# 把 mo 技能装到主 Agent 的技能目录。
#   bash scripts/install-skill.sh              # 自动检测 ~/.dsh/skills 与 ~/.claude/skills
#   bash scripts/install-skill.sh --uninstall
#   MO_SKILL_DIR=/some/skills bash scripts/install-skill.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/skills/mo"
NAME="mo"

UNINSTALL=0
[ "${1:-}" = "--uninstall" ] && UNINSTALL=1

TARGETS=()
[ -n "${MO_SKILL_DIR:-}" ] && TARGETS+=("$MO_SKILL_DIR")
TARGETS+=("$HOME/.agents/skills")   # 通用位置，总是装
TARGETS+=("$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.qoder/skills" "$HOME/.qoder-cn/skills" "$HOME/.qwen/skills")

[ -d "$SRC" ] || { echo "找不到技能源目录：$SRC" >&2; exit 1; }

for dir in "${TARGETS[@]}"; do
  parent="$(dirname "$dir")"
  # 通用位置总是建；Agent 目录只在它存在时才装
  if [ -z "${MO_SKILL_DIR:-}" ] && [ "$dir" != "$HOME/.agents/skills" ] && [ ! -d "$parent" ]; then
    continue
  fi
  if [ "$UNINSTALL" = "1" ]; then
    if [ -d "$dir/$NAME" ]; then
      if rm -rf "$dir/$NAME" 2>/dev/null; then
        echo "已移除 $dir/$NAME"
      else
        echo "跳过（无写权限）：$dir/$NAME" >&2
      fi
    fi
    continue
  fi
  mkdir -p "$dir" 2>/dev/null || { echo "跳过（无法创建）：$dir" >&2; continue; }
  rm -rf "$dir/$NAME" 2>/dev/null || true
  if cp -R "$SRC" "$dir/$NAME" 2>/dev/null; then
    echo "已安装 $dir/$NAME"
  else
    echo "跳过（无写权限）：$dir" >&2
  fi
done

if [ "$UNINSTALL" = "1" ]; then
  exit 0
fi

cat <<'TIP'

技能已安装。主 Agent 需要新开会话才会加载它。
装完后可以直接说："给这个项目加个功能，开始做吧"。
TIP