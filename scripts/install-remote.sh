#!/usr/bin/env bash
# 从 GitHub Releases 安装 mo（不需要源码、不需要 Node）。
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/install-remote.sh | bash
#   MO_VERSION=v0.2.0 bash scripts/install-remote.sh      # 指定版本
#   MO_CLI_BASE_URL=file:///path/to/dist bash scripts/install-remote.sh   # 本地验证
set -euo pipefail

REPO="${MO_AGENT_REPO:-CHANGE_ME/mo-agent}"
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

echo "下载 $URL"
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

echo "已安装：$BIN_DIR/mo"
"$BIN_DIR/mo" --version

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "注意：$BIN_DIR 不在 PATH 中，加进去并重开终端" ;;
esac

# 技能：默认一起装（--no-skill 或 MO_SKIP_SKILL=1 可跳过）
if [ "${MO_SKIP_SKILL:-0}" != "1" ] && [ "${1:-}" != "--no-skill" ]; then
  if "$BIN_DIR/mo" skill install --yes >/dev/null 2>&1; then
    echo "技能已安装（mo skill list 查看）"
  else
    echo "技能安装跳过；之后可手动执行：mo skill install"
  fi
fi