#!/usr/bin/env bash
# 安装 mo-agent.app 到 ~/Applications 并使其可以「双击」直接运行。
#
# 关键顺序（踩过坑）：
#   1. 拷贝 + 签名
#   2. 跑一次完成 Electrobun 的首次安装 —— 这一步会把 bundle 改写成解包形态
#   3. 退出
#   4. 「再次」签名 —— 因为第 2 步改写了内容，之前的签名已经失效；
#      签名失效时 `open` 还能起，但「双击」会被 Gatekeeper 拒绝（常常无提示）。
#
# 另一条规则：不要直接运行 desktop/build/ 里的成品，那个目录是用于分发的。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="desktop/build/stable-macos-arm64/mo-agent.app"
# 默认装到 /Applications —— 也就是 Finder 里「应用程序」显示的那个（macOS 惯例）。
# 没有写权限（不在 admin 组）时退回 ~/Applications。
DEFAULT_DIR="/Applications"
if [ ! -w "$DEFAULT_DIR" ]; then DEFAULT_DIR="$HOME/Applications"; fi
DEST_DIR="${MO_AGENT_APP_DIR:-$DEFAULT_DIR}"
DEST="$DEST_DIR/mo-agent.app"
CACHE="$HOME/Library/Application Support/dev.moagent.desktop"
PORT="${MO_AGENT_PORT:-7788}"

if [ ! -d "$SRC" ]; then
  echo "还没构建。先跑：scripts/build-desktop.sh" >&2
  exit 1
fi
if [ ! -f "$SRC/Contents/Resources/metadata.json" ]; then
  echo "构建产物不完整（缺 metadata.json）——它可能已经被运行过。" >&2
  echo "重新构建后再安装：scripts/build-desktop.sh" >&2
  exit 1
fi

# 停掉任何从该 bundle 启动的进程。注意：提交之后真正在跑的是 cottontail，
# 进程名里不一定有 launcher，所以按 bundle 路径和 host 入口一起匹配。
stop_running() {
  pkill -f "mo-agent.app/Contents/MacOS/" 2>/dev/null || true
  pkill -f "host/index.mjs" 2>/dev/null || true
  pkill -f "mo-agent/runtime/bin/mo-agent-host" 2>/dev/null || true
  pkill -f "mo-voice-bridge" 2>/dev/null || true
  sleep 1
  pkill -9 -f "mo-agent.app/Contents/MacOS/" 2>/dev/null || true
  pkill -9 -f "host/index.mjs" 2>/dev/null || true
  pkill -9 -f "mo-agent/runtime/bin/mo-agent-host" 2>/dev/null || true
  pkill -9 -f "mo-voice-bridge" 2>/dev/null || true
  sleep 1
}

sign_bundle() {
  local target="$1"
  # 先签嵌套的可执行文件与动态库，再签整个 bundle
  find "$target/Contents" -type f -perm -u+x \
    \( -name "*.dylib" -o -name "launcher" -o -name "cottontail" -o -name "bspatch" -o -name "zig-zstd" -o -name "uninstall" \) \
    -exec codesign --force --sign - {} \; 2>/dev/null || true
  codesign --force --deep --sign - "$target"
}

# 停掉正在运行的实例
stop_running

mkdir -p "$DEST_DIR"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[install] 注意：$PORT 仍被占用，可能是别处手动起的服务" >&2
fi
# 用「改名再删」而不是直接删：macOS 只要认为 App 在使用，rm -rf 就可能失败；
# 而同一目录内改名几乎总能成功（只挪目录项，不动 inode）。
if [ -e "$DEST" ]; then
  OLD="$DEST.old-$$"
  if mv "$DEST" "$OLD" 2>/dev/null; then
    rm -rf "$OLD" 2>/dev/null || echo "[install] 旧的已挪到 $OLD，稍后可手动删除" >&2
  elif rm -rf "$DEST" 2>/dev/null; then
    :
  else
    echo "[install] !! 既删不掉也挪不走旧目录：" >&2
    echo "         $DEST" >&2
    echo "         诊断：" >&2
    ls -ldO "$DEST" 2>&1 | sed "s/^/           /" >&2
    ls -lde "$DEST" 2>&1 | sed "s/^/           /" >&2
    exit 1
  fi
fi
cp -R "$SRC" "$DEST" || { echo "[install] !! 拷贝失败。若报 Permission denied，检查 $DEST_DIR 的权限" >&2; exit 1; }
sign_bundle "$DEST"
echo "[install] 已拷贝并签名: $DEST"

# ---- 跑一次完成首次安装（会改写 bundle）----
echo "[install] 执行首次安装（静默）..."
rm -rf "$CACHE" 2>/dev/null || echo "[install] 注意：旧的安装状态没删掉，可能影响结果" >&2

"$DEST/Contents/MacOS/launcher" --quiet >/dev/null 2>&1 &
BOOT_PID=$!
installed=0
for _ in $(seq 1 90); do
  if curl -s -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then installed=1; break; fi
  sleep 1
done
sleep 2

kill "$BOOT_PID" 2>/dev/null || true
stop_running

if [ "$installed" = "1" ]; then
  echo "[install] 首次安装完成（服务已能响应）"
else
  echo "[install] 警告：90 秒内没等到服务响应。" >&2
  echo "          日志：$HOME/Library/Logs/mo-agent/host.log" >&2
fi

# Electrobun 首次解包会在 MacOS 目录留下 .cottontail-tmp，
# codesign 会因此认为 bundle 格式无效（"bundle format unrecognized"）。
rm -rf "$DEST/Contents/MacOS/.cottontail-tmp" 2>/dev/null || true

# 首次安装会重写 Info.plist，只剩 CFBundle* 最小字段，LSUIElement 会丢：
# 丢了就会出现在 Dock 里，关窗口也留下「运行中」的小点。
# 必须在最终签名之前补回来。
PLIST="$DEST/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :LSUIElement" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string mo-agent 需要麦克风来接收你的语音确认，音频只在本机识别。" "$PLIST"

# ---- 关键：提交改写了 bundle，必须重新签名，否则双击会被拒绝 ----
echo "[install] 重新签名（提交改写过 bundle）"
sign_bundle "$DEST"
if codesign --verify "$DEST" >/dev/null 2>&1; then
  echo "[install] 签名校验通过 —— 现在可以双击运行"
else
  codesign --verify --verbose "$DEST" || true
  echo "[install] !! 签名校验未通过，双击可能被 Gatekeeper 拒绝" >&2
  exit 1
fi

echo "[install] 运行: open \"$DEST\"  或直接双击"

