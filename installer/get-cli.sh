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

URL="$(resolve_url || true)"   # grep 无匹配时别让 set -e 直接退出
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
echo "  mo setup         首次装配（幂等）：配置、记忆、默认执行者/终端、技能、MCP"
echo "                   会问要不要配指挥台（那一步要下载约 150MB，可以说不）"
echo "                   先看它会做什么：mo setup --dry-run"
if [ "$WITH_SKILL" != "1" ]; then
  echo "                   只想要技能：mo skill install"
fi
echo "  mo doctor        自检；最后一行会告诉你「下一步做什么」"
echo
echo "先选一条路（随时可以换）："
echo "  只看不改         装桌面 App + 手机：收通知、远程批准，不碰命令"
echo "  接外部 Agent     mo connect describe    提示词 / MCP / 技能三种接法"
echo "  用内置指挥台     mo router start        mo 自己的主 Agent，只分派不动手"
echo "  只敲命令         看下面这段"
echo
echo "基本用法（在项目目录里）："
echo "  mo project create            认领当前目录：写 .mo-agent/ 与 Agent 说明"
echo "  mo worker list               看可用执行者（裸名=会话，-headless=无头）"
echo '  mo task create --title hello --deliverable "print hello world" \'
echo '                 --verify "run:echo hello world" --worker claude-headless'
echo "                    TTY 下会问「现在批准并派单吗」，答 y 一步到底"
echo "  mo task show <id>            状态 / 验收 / 待批 / 结论"
echo "  mo task dispatch <id> --detach"
echo "                   批准后后台派单（手机也能点「允许并派单」）"
echo "  mo inbox pull                收结果；也可以等手机通知"
echo "  mo ledger query --task <id>  这条任务的时间线"
echo
echo "没在 create 时批准：mo task confirm <id> 发起请求，手机或终端批准后再 dispatch"
echo "命令以 mo help 为准（mo help --all 看全部分组，mo help <组> 看细节）。"