#!/usr/bin/env bash
# 打包 mo-agent 桌面托盘（Electrobun）。
#
# 三个必须保留的步骤：
#   1) 把 host 运行时组装到 desktop/runtime，并通过 build.copy 打进载荷
#      （必须在 electrobun build 之前，否则首次解包会把它丢掉）
#   2) 写入 LSUIElement（必须在签名之前，否则破坏签名）
#   3) ad-hoc 重签（补上资源封印）
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

# ---- 1. 组装 host 运行时（单文件可执行 + web 资源）----
# 桌面壳首次启动会把它安装/覆盖到 ~/Library/Application Support/mo-agent/runtime。
BUN="${BUN:-}"
if [ -z "$BUN" ]; then BUN="$(command -v bun 2>/dev/null || true)"; fi
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ -z "$BUN" ]; then
  echo "[build] !! 找不到 bun（用于把 host 编译成单文件）。安装 bun 或设置 BUN=/path/to/bun" >&2
  exit 1
fi

RUNTIME_STAGE="desktop/runtime"
rm -rf "$RUNTIME_STAGE"
mkdir -p "$RUNTIME_STAGE/bin" "$RUNTIME_STAGE/app/web"

echo "[build] 编译 host 运行时: $BUN"
"$BUN" build host/index.mjs --target=bun --compile --outfile "$RUNTIME_STAGE/bin/mo-agent-host"
chmod +x "$RUNTIME_STAGE/bin/mo-agent-host"
cp -R app/web/. "$RUNTIME_STAGE/app/web/"
mkdir -p "$RUNTIME_STAGE/adapters/profiles"
cp -R adapters/profiles/. "$RUNTIME_STAGE/adapters/profiles/"

if [ -f host/notify-defaults.json ]; then
  cp host/notify-defaults.json "$RUNTIME_STAGE/notify-defaults.json"
else
  echo "[build] 警告：缺少 host/notify-defaults.json，HMS 通道不会自动配置" >&2
fi

# 可选：把 APK 一起带上，供 /setup 页下载
APK="app/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  mkdir -p "$RUNTIME_STAGE/app/android/app/build/outputs/apk/debug"
  cp "$APK" "$RUNTIME_STAGE/app/android/app/build/outputs/apk/debug/app-debug.apk"
  if [ -f "app/android/app/build/outputs/apk/debug/version.json" ]; then
    cp "app/android/app/build/outputs/apk/debug/version.json" "$RUNTIME_STAGE/app/android/app/build/outputs/apk/debug/version.json"
  fi
else
  echo "[build] 警告：未找到 $APK，分发包将无法扫码安装；先跑 ./scripts/build-android.sh" >&2
fi

# ---- 语音资源：录音器 + 静态 whisper + 模型，直接进包 ----
# 0.2.x 的明确决策：模型内置，不做首次下载。
#   - 语音资源约 254MB（whisper-cli 约 1.3MB + ggml-small-q8_0 约 252MB），成品 App 约 282MB
#   - 升级 App 会带全量模型重新解包，没有增量下载
#   - 运行时可用 MO_AGENT_WHISPER_MODEL=/path/to/ggml-*.bin 覆盖模型路径；
#     host 的选择顺序：MO_AGENT_WHISPER_MODEL > runtime/voice/models/ggml-small-q8_0.bin
#     > runtime/voice/models/ggml-base.bin
#   - WITH_VOICE=0 打出不带语音资源的轻量包（约 46MB），此时语音开关会报不可用
# 以后若减包体，单独开任务：首次启用时下载到
# ~/Library/Application Support/mo-agent/models/，并处理 SHA256、镜像回退、进度与失败降级。
# 本轮只固化策略，不实现下载。
WITH_VOICE="${WITH_VOICE:-1}"
if [ "$WITH_VOICE" = "1" ]; then
  if [ ! -d ".build/mo-agent 语音.app" ]; then
    echo "[build] 构建语音桥…"
    ./scripts/build-voice-bridge.sh
  fi
  if [ ! -x ".build/bin/whisper-cli" ] || [ ! -s ".build/models/ggml-small-q8_0.bin" ]; then
    echo "[build] 构建 whisper 与模型（首次会下载约 252MB）…"
    ./scripts/build-whisper.sh
  fi
  mkdir -p "$RUNTIME_STAGE/voice/whisper/bin" "$RUNTIME_STAGE/voice/models"
  cp -R ".build/mo-agent 语音.app" "$RUNTIME_STAGE/voice/"
  cp -f ".build/bin/whisper-cli" "$RUNTIME_STAGE/voice/whisper/bin/whisper-cli"
  cp -f ".build/models/ggml-small-q8_0.bin" "$RUNTIME_STAGE/voice/models/ggml-small-q8_0.bin"
  chmod +x "$RUNTIME_STAGE/voice/whisper/bin/whisper-cli"
  echo "[build] 语音资源: $(du -sh "$RUNTIME_STAGE/voice" | cut -f1)"
else
  echo "[build] WITH_VOICE=0，跳过语音资源"
fi

printf '{"version":"%s","builtAt":"%s"}\n' "$(date +%Y%m%d%H%M%S)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RUNTIME_STAGE/runtime.json"
echo "[build] runtime 体积: $(du -sh "$RUNTIME_STAGE" | cut -f1)"

# build.copy 只支持单文件，所以打成 tar.gz；壳首次启动解压到固定目录
tar -czf desktop/runtime.tar.gz -C "$RUNTIME_STAGE" .
echo "[build] runtime 包: $(du -sh desktop/runtime.tar.gz | cut -f1)"

# ---- 2. Electrobun 构建（copy 会带上 runtime）----
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
TAR_ZST="$(ls "$APP/Contents/Resources/"*.tar.zst 2>/dev/null | head -1)"
if [ -n "$TAR_ZST" ] && tar --zstd -tf "$TAR_ZST" 2>/dev/null | grep -q "Contents/Resources/app/runtime.tar.gz"; then
  echo "[build] 布局校验通过：自解压包 + metadata.json + runtime.tar.gz 齐全"
else
  echo "[build] !! 载荷里没有 runtime.tar.gz，检查 electrobun.config.ts 的 build.copy 映射" >&2
  exit 1
fi

# ---- 3. LSUIElement + 重签 ----
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :LSUIElement" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"

# 外层 App 也要声明麦克风用途：TCC 探针如果认父 App，就靠这条说明。
/usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string mo-agent 需要麦克风来接收你的语音确认，音频只在本机识别。" "$PLIST"

echo "[build] ad-hoc 重签"
codesign --force --deep --sign - "$APP"
codesign --verify --verbose "$APP"

echo "[build] 产物: $APP"
du -sh "$APP" 2>/dev/null || true
echo "[build] 安装到稳定位置再运行: scripts/install-desktop.sh"
