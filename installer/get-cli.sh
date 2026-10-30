#!/usr/bin/env bash
# 从 GitHub Releases 安装 mo（不需要源码、不需要 Node）。
#   curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/installer/get-cli.sh | bash
#   ... | bash -s -- --with-skill    # 顺带安装 Agent 技能
#   ... | bash -s -- --with-apk      # 顺带下载手机安装包到 ~/.mo-agent/app.apk
#   MO_VERSION=cli-v0.2.0 bash installer/get-cli.sh  # 指定版本
#   MO_CLI_BASE_URL=file:///path/to/dist bash installer/get-cli.sh   # 本地验证
set -euo pipefail

REPO="${MO_AGENT_REPO:-insky2005/mo-agent}"
BIN_DIR="${MO_BIN_DIR:-$HOME/.local/bin}"
BASE="${MO_CLI_BASE_URL:-}"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) echo "Windows 请用：installer/get-cli.ps1" >&2; exit 1 ;;
  *) echo "暂不支持的系统：$(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) echo "暂不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

ASSET="mo-${OS}-${ARCH}"

# 解析下载地址。
# CLI 用 cli-v* 前缀，所以不能靠 releases/latest（那会被 APK/desktop 的 release 抢走）。
# 默认从新到旧找第一个「真的带这个资产」的 release。
resolve_url() {
  if [ -n "$BASE" ]; then
    echo "$BASE/$ASSET"
    return 0
  fi

  if [ -n "${MO_VERSION:-}" ]; then
    case "$MO_VERSION" in
      cli-v*) TAG="$MO_VERSION" ;;
      v*) TAG="cli-$MO_VERSION" ;;        # 兼容裸 tag
      *) TAG="cli-$MO_VERSION" ;;
    esac
    echo "https://github.com/$REPO/releases/download/$TAG/$ASSET"
    return 0
  fi

  curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null \
    | grep -o "\"browser_download_url\": *\"[^\"]*/$ASSET\"" \
    | head -1 \
    | sed 's/.*"\(https[^"]*\)"/\1/'
}

URL="$(resolve_url)"
if [ -z "$URL" ]; then
  echo "找不到 $ASSET 的 release。检查：仓库是否公开、是否已发过 cli-v* 版本。" >&2
  echo "也可以指定版本：MO_VERSION=cli-v0.2.0 bash installer/get-cli.sh" >&2
  exit 1
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
WITH_APK="${MO_WITH_APK:-0}"
for arg in "$@"; do
  case "$arg" in
    --with-skill) WITH_SKILL=1 ;;
    --no-skill) WITH_SKILL=0 ;;
    --with-apk) WITH_APK=1 ;;
  esac
done

# 手机扫码安装用的 APK：host 会从 ~/.mo-agent/app.apk 提供 /app.apk
if [ "$WITH_APK" = "1" ]; then
  if curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/fetch-apk.sh" | bash; then
    echo "✓ APK"
  else
    echo "APK 下载失败，可稍后执行：bash scripts/fetch-apk.sh" >&2
  fi
fi

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
echo "  mo worker list                看可用的执行者（裸名=会话，-headless=无头）"
echo '  mo task create --title hello --deliverable "print hello world" \'
echo '                 --verify "run:echo hello world" --worker claude-headless \'
echo '                 --workdir .        # 相对项目根（默认就是项目根，不是当前目录）'
echo "  mo task confirm <id>          发起确认请求（不改状态）"
echo "  mo task approve <id>          人批准（终端里执行）"
echo "  mo task dispatch <id>         派给执行者并等回执（自动验收）"
echo "  mo task status <id>           看状态与最近事件"
echo "  mo task list                  看本项目的任务"
echo "  mo ledger query --task <id>   看这条任务的时间线"