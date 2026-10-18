#!/usr/bin/env bash
# 打包 Android APK。三个缓存/用户目录都放在工作区内，避免依赖家目录写权限。
# 每次构建自动递增 versionCode，并生成版本信息供 App 与 /app/version 使用。
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "找不到 JDK 21，请设置 JAVA_HOME" >&2; exit 1
fi
export JAVA_HOME
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$PWD/.prestudy/android-home}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$PWD/.prestudy/gradle}"
mkdir -p "$ANDROID_USER_HOME" "$GRADLE_USER_HOME"

GRADLE="app/android/app/build.gradle"
CUR=$(grep -oE "versionCode [0-9]+" "$GRADLE" | grep -oE "[0-9]+")
NEXT=$((CUR + 1))
NAME=$(grep -oE 'versionName "[^"]+"' "$GRADLE" | head -1 | sed 's/versionName //')
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sed -i "" "s/versionCode $CUR/versionCode $NEXT/" "$GRADLE"
printf '{"versionCode":%d,"versionName":%s,"builtAt":"%s"}\n' "$NEXT" "$NAME" "$BUILT_AT" > app/web/build-info.json
echo "[build] versionCode $CUR -> $NEXT  versionName $NAME"

( cd app && npx cap sync android )
# 每次 versionCode 变化都改 SW 缓存名，旧 APK 的 SW 才会安装新版本并重新缓存资源。
SW="app/android/app/src/main/assets/public/sw.js"
if [ -f "$SW" ]; then
  sed -i "" -E "s/mo-agent-v[0-9]+/mo-agent-v$NEXT/" "$SW"
  echo "[build] SW cache -> mo-agent-v$NEXT"
fi
( cd app/android && ./gradlew assembleDebug --no-daemon )

APK="app/android/app/build/outputs/apk/debug/app-debug.apk"
cp app/web/build-info.json "app/android/app/build/outputs/apk/debug/version.json" 2>/dev/null || true

echo "[build] 产物: $APK"
ls -la "$APK"
echo "[build] 安装: adb install -r $APK"

