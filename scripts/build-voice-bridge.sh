#!/usr/bin/env bash
# 构建语音桥。Swift 的模块缓存默认落在 /var/folders，工作区沙箱下不可写，
# 所以显式指到 .build/swift-cache。
#
# 必须打成 .app：裸命令行进程访问麦克风会被 TCC 直接 SIGABRT，
# 只有带 Info.plist 的 bundle 才会弹权限框。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.build/swift-cache"
APP="$ROOT/.build/mo-agent 语音.app"
BIN="$APP/Contents/MacOS/mo-voice-bridge"
mkdir -p "$CACHE" "$APP/Contents/MacOS"

CLANG_MODULE_CACHE_PATH="$CACHE" SWIFT_MODULECACHE_PATH="$CACHE" \
  swiftc -O -module-cache-path "$CACHE" \
  -framework AVFoundation -framework AppKit \
  "$ROOT/host/voice/bridge.swift" \
  -o "$BIN"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>mo-voice-bridge</string>
  <key>CFBundleIdentifier</key><string>cn.mocampus.moagent.voicebridge</string>
  <key>CFBundleName</key><string>mo-agent 语音</string>
  <key>CFBundleDisplayName</key><string>mo-agent 语音</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>mo-agent 需要麦克风来接收你的语音确认，音频只在本机识别。</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" 2>/dev/null || echo "warning: codesign 失败，权限框可能不出现" >&2
ln -sf "$BIN" "$ROOT/.build/mo-voice-bridge"
echo "built $BIN"
