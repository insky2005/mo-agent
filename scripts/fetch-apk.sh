#!/usr/bin/env bash
# 下载最新 APK 到本机，供 host 的 /app.apk（扫码安装）使用。
#
#   bash scripts/fetch-apk.sh                  # 存到 ~/.mo-agent/app.apk
#   bash scripts/fetch-apk.sh /tmp/mo.apk      # 指定路径
#   MO_APK_TAG=apk-v0.2.0 bash scripts/fetch-apk.sh
set -euo pipefail

REPO="${MO_AGENT_REPO:-insky2005/mo-agent}"
DEST="${1:-${MO_APK_DEST:-$HOME/.mo-agent/app.apk}}"

pick_asset() {
  grep -o '"browser_download_url": *"[^"]*mo-agent-android-[^"]*\.apk"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/'
}

if [ -n "${MO_APK_URL:-}" ]; then
  URL="$MO_APK_URL"
elif [ -n "${MO_APK_TAG:-}" ]; then
  URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$MO_APK_TAG" | pick_asset)"
  [ -n "$URL" ] || { echo "tag $MO_APK_TAG 里没有 APK 资产" >&2; exit 1; }
else
  # releases 按时间倒序，取第一个带 .apk 资产的
  URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=20" | pick_asset)"
  [ -n "$URL" ] || { echo "还没发布过 APK（需要先推 apk-v* tag）" >&2; exit 1; }
fi

NAME="$(basename "$URL")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "下载 $NAME …"
curl -fL --retry 2 -o "$TMP/$NAME" "$URL"

if curl -fsSL -o "$TMP/$NAME.sha256" "$URL.sha256" 2>/dev/null; then
  if ( cd "$TMP" && shasum -a 256 -c "$NAME.sha256" >/dev/null 2>&1 ); then
    echo "✓ 校验和通过"
  else
    echo "✗ 校验和不匹配，已中止" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$DEST")"
cp "$TMP/$NAME" "$DEST"
echo "✓ APK: $DEST"
echo "  重启 host 后手机扫码即可安装（/app.apk）"
