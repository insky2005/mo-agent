#!/usr/bin/env bash
# 打包 mo-agent 桌面托盘（Electrobun）。
#
# 两个必须保留的步骤，缺一个都会导致「第一次能开、之后打不开」：
#   1) 写入 LSUIElement（必须在签名之前，否则破坏签名）
#   2) ad-hoc 重签（补上资源封印）
#
# 另：构建产物只能"分发"，不能直接长期运行——Electrobun 的 launcher 首次运行会
# 把解包运行时提交回 .app 本身。请在稳定位置运行，见 scripts/install-desktop.sh。
set -euo pipefail
cd "$(dirname "$0")/.."

export HUTCH_HOME="${HUTCH_HOME:-$PWD/.prestudy/hutch}"
export PATH="$HUTCH_HOME/bin:$PATH"

if ! command -v hutch >/dev/null 2>&1; then
  echo "[build] 未找到 hutch，先安装：" >&2
  echo "  export HUTCH_HOME=$HUTCH_HOME" >&2
  echo "  curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh" >&2
  exit 1
fi

# 清掉旧产物，避免残留形态混进来
rm -rf desktop/build
( cd desktop && hutch install && hutch run build )

APP="desktop/build/stable-macos-arm64/mo-agent.app"

# 布局校验：成品必须是「launcher + 自解压包 + metadata.json」这一形态
if [ ! -f "$APP/Contents/Resources/metadata.json" ]; then
  echo "[build] !! 产物不完整：缺 metadata.json" >&2
  exit 1
fi
if ! ls "$APP/Contents/Resources/" | grep -q "\.tar\.zst$"; then
  echo "[build] !! 产物不完整：缺 .tar.zst" >&2
  exit 1
fi
echo "[build] 布局校验通过：自解压包 + metadata.json 齐全"

# 设为菜单栏常驻 App：不占 Dock。必须在签名前写，否则会破坏签名。
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :LSUIElement" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"

# Electrobun 的 mac.codesign 默认 false，资源没被封印，codesign -v 会失败；
# macOS 首次可由用户显式放行，之后每次双击都会校验并拒绝启动。
# 本地没有 Apple 开发者证书，所以用 ad-hoc 重签把资源封印补上。
echo "[build] ad-hoc 重签"
codesign --force --deep --sign - "$APP"
codesign --verify --verbose "$APP"

echo "[build] 产物: $APP"
du -sh "$APP" 2>/dev/null || true
echo "[build] 安装到稳定位置再运行: scripts/install-desktop.sh"

