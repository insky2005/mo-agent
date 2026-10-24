#!/usr/bin/env bash
# 从 GitHub Releases 安装 mo（不需要源码、不需要 Node）。
#   curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/scripts/install-remote.sh | bash
#   ... | bash -s -- --with-skill    # 顺带安装 Agent 技能
#   MO_VERSION=v0.2.0 bash scripts/install-remote.sh      # 指定版本
#   MO_CLI_BASE_URL=file:///path/to/dist bash scripts/install-remote.sh   # 本地验证
set -euo pipefail

REPO="${MO_AGENT_REPO:-insky2005/mo-agent}"
BIN_DIR="${MO_BIN_DIR:-$HOME/.local/bin}"
BASE="${MO_CLI_BASE_URL:-}"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *) echo "暂不支持的系统：$(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) echo "暂不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

ASSET="mo-${OS}-${ARCH}"

if [ -n "$BASE" ]; then
  URL="$BASE/$ASSET"
else
  if [ -n "${MO_VERSION:-}" ]; then
    URL="https://github.com/$REPO/releases/download/$MO_VERSION/$ASSET"
  else
    URL="https://github.com/$REPO/releases/latest/download/$ASSET"
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "下载 mo…"
if ! curl -fL --retry 2 -o "$TMP/$ASSET" "$URL"; then
  echo "下载失败。检查：仓库名是否正确、Release 是否已发布、仓库是否公开。" >&2
  exit 1
fi

# 有校验文件就校验
if curl -fsL -o "$TMP/$ASSET.sha256" "$URL.sha256" 2>/dev/null; then
  (cd "$TMP" && shasum -a 256 -c "$ASSET.sha256")
fi

chmod +x "$TMP/$ASSET"
mkdir -p "$BIN_DIR"
mv "$TMP/$ASSET" "$BIN_DIR/mo"

echo
echo "✓ 已安装 $BIN_DIR/mo"
"$BIN_DIR/mo" --version

WITH_SKILL="${MO_WITH_SKILL:-0}"
for arg in "$@"; do
  case "$arg" in
    --with-skill) WITH_SKILL=1 ;;
    --no-skill) WITH_SKILL=0 ;;
  esac
done

if [ "$WITH_SKILL" = "1" ]; then
  if [ -t 0 ]; then
    "$BIN_DIR/mo" skill install || true
  elif "$BIN_DIR/mo" skill install --yes >/dev/null 2>&1; then
    echo "✓ 技能"
  else
    echo "技能未安装，可稍后执行：mo skill install"
  fi
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    printf 'PATH 未包含 %s，当前终端先执行：\n' "$BIN_DIR"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    echo "（要永久生效，把这一行加进你的 shell 配置）"
    ;;
esac

echo
echo "下一步："
if [ "$WITH_SKILL" != "1" ]; then
  echo "  mo skill install        给 Claude / Codex / Qoder 等安装 mo 技能（交互选择）"
fi
echo "  mo project init         在项目目录初始化 .mo-agent/ 并写入 Agent 说明"
echo
echo "基本用法（在项目里）："
echo "  mo worker list           看可用的执行者模板"
echo '  mo task create --title hello --deliverable "print hello world" --verify "run:echo hello world" --worker claude'
echo "  mo task confirm <id>     人确认；确认前不能派单"
echo "  mo task dispatch <id>    派给执行者并等回执"
echo "  mo task list             看本项目的任务"