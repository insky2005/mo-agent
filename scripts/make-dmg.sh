#!/usr/bin/env bash
# 生成可分发的 DMG。
#
# 里面有三样东西：
#   1. mo-agent.app          —— 可分发的成品（自解压形态）
#   2. Applications 软链接    —— 直接拖进去即可（macOS 惯例）
#   3. 安装到应用程序.command —— 双击运行，做完整安装（含首次初始化后重新签名）
#
# 为什么需要第 3 样：Electrobun 的 launcher 首次运行会把 bundle 改写成解包形态，
# 那一步会让签名失效 —— 只拖拽的话，第一次能开、之后双击会被 Gatekeeper 拒绝。
set -euo pipefail
cd "$(dirname "$0")/.."

APP="$(ls -d desktop/build/stable-macos-*/mo-agent.app 2>/dev/null | head -1)"
OUT="desktop/build/mo-agent-$(date +%Y%m%d).dmg"

if [ ! -d "$APP" ]; then
  echo "[dmg] 还没构建。先跑：scripts/build-desktop.sh" >&2
  exit 1
fi
if [ ! -f "$APP/Contents/Resources/metadata.json" ] || ! ls "$APP/Contents/Resources/" | grep -q "\.tar\.zst$"; then
  echo "[dmg] !! 产物不是可分发形态（缺 metadata.json 或 .tar.zst）" >&2
  echo "       它可能已经被运行过。重新构建：scripts/build-desktop.sh" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/mo-agent.app"
ln -s /Applications "$STAGE/Applications"

# ---- 双击式安装器 ----
cat > "$STAGE/安装到应用程序.command" <<'CMDEOF'
#!/bin/bash
# 双击 .command 时 Terminal 可能用 zsh 执行，不认 shebang；强制转回 bash。
if [ -z "${BASH_VERSION:-}" ]; then exec /bin/bash "$0" "$@"; fi
# 双击运行。把 mo-agent 装到 /Applications，完成首次初始化并重新签名。
set -uo pipefail
cd "$(dirname "$0")"

SRC="$PWD/mo-agent.app"
DEST="/Applications/mo-agent.app"
CACHE="$HOME/Library/Application Support/dev.moagent.desktop"
PORT=7788

echo "mo-agent 安装器"
echo "---------------"

if [ ! -d "$SRC" ]; then echo "找不到 mo-agent.app（请从 DMG 里运行本脚本）"; read -r -p "按回车关闭"; exit 1; fi

echo "[1/5] 停止正在运行的实例"
pkill -f "mo-agent.app/Contents/MacOS/" 2>/dev/null || true
pkill -f "host/index.mjs" 2>/dev/null || true
sleep 1

echo "[2/5] 拷贝到 /Applications"
if [ -e "$DEST" ]; then mv "$DEST" "$DEST.old-$$" 2>/dev/null && rm -rf "$DEST.old-$$" 2>/dev/null || true; fi
rm -rf "$DEST" 2>/dev/null || true
cp -R "$SRC" "$DEST" || { echo "!! 拷贝失败。若提示权限不足，请用管理员账号或 sudo。"; read -r -p "按回车关闭"; exit 1; }

echo "[3/5] 首次签名"
codesign --force --deep --sign - "$DEST" 2>/dev/null || true

echo "[4/5] 首次初始化（会改写 bundle，属正常）"
rm -rf "$CACHE" 2>/dev/null || true
"$DEST/Contents/MacOS/launcher" --quiet >/dev/null 2>&1 &
BOOT=$!
ok=0
for _ in $(seq 1 90); do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
sleep 2
kill "$BOOT" 2>/dev/null || true
pkill -f "mo-agent.app/Contents/MacOS/" 2>/dev/null || true
pkill -f "host/index.mjs" 2>/dev/null || true
sleep 2

echo "[5/5] 重新签名（提交改写过 bundle，必须重签）"
find "$DEST/Contents" -type f -perm -u+x \( -name "*.dylib" -o -name "launcher" -o -name "cottontail" -o -name "bspatch" -o -name "zig-zstd" -o -name "uninstall" \) -exec codesign --force --sign - {} \; 2>/dev/null || true
codesign --force --deep --sign - "$DEST" 2>/dev/null || true

if codesign --verify --verbose "$DEST" 2>&1 | grep -q "valid on disk"; then
  echo
  echo "✓ 安装完成。现在可以直接双击：/Applications/mo-agent.app"
  if [ "$ok" != "1" ]; then echo "  （提示：首次初始化的服务探测没成功，如果双击后没反应，看 ~/Library/Logs/mo-agent/host.log）"; fi
else
  echo
  echo "!! 签名校验没通过，双击可能仍被拒绝。把上面的输出发给开发者。"
fi
echo
read -r -p "按回车关闭本窗口"
CMDEOF
chmod +x "$STAGE/安装到应用程序.command"

cat > "$STAGE/安装说明.txt" <<'TXTEOF'
mo-agent 桌面版安装说明
========================

方式一（推荐，最省事）：
  双击「安装到应用程序.command」
  它会自动完成后，直接双击 /Applications/mo-agent.app 即可。

方式二（常规拖拽）：
  把 mo-agent.app 拖到左边的 Applications 图标上，然后双击运行。

  注意：Electrobun 的启动器首次运行会做一次初始化（约 10 秒，有进度窗），
  这一步会把应用改写成运行时形态并让签名失效 —— 所以拖拽安装后，
  第一次能开，之后双击可能被 macOS 拒绝。遇到这种情况请改用方式一。

关于安全提示：
  本应用未做 Apple 公证，首次运行会提示「无法验证开发者」或「无法打开，
  因为 Apple 无法检查其是否包含恶意软件」。这是预期内的，处理方式：
    · 在「系统设置 → 隐私与安全性」里点「仍要打开」，或
    · 右键点 App → 打开 → 再点「打开」

卸载：
  rm -rf /Applications/mo-agent.app
  rm -rf ~/Library/Application\ Support/dev.moagent.desktop
  rm -rf ~/Library/Logs/mo-agent
TXTEOF

rm -f "$OUT"
hdiutil create -volname "mo-agent" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null

echo "[dmg] 产物: $OUT"
ls -lh "$OUT" | awk '{print "       体积: " $5}'
echo "[dmg] 内容: mo-agent.app / Applications 软链接 / 安装到应用程序.command / 安装说明.txt"

