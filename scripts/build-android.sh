#!/usr/bin/env bash
# 打包 Android APK。三个缓存/用户目录都放在工作区内，避免依赖家目录写权限。
# 每次构建自动递增 versionCode（CI 里用 MO_VERSION_CODE 固定），并生成版本信息供 App 与 /app/version 使用。
#
#   bash scripts/build-android.sh
#   MO_VERSION_CODE=200 MO_VERSION_NAME=0.2.0 bash scripts/build-android.sh   # CI：版本由 tag 决定
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

# 版本号：CI 用 tag 推出来的值；本地自增，方便每次装上就是新版本
if [ -n "${MO_VERSION_CODE:-}" ]; then
  CODE="$MO_VERSION_CODE"
  echo "[build] versionCode 由环境变量指定：$CODE"
else
  CUR="$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const m=s.match(/versionCode (\d+)/);console.log(m?m[1]:0)' "$GRADLE")"
  CODE=$((CUR + 1))
  echo "[build] versionCode $CUR -> $CODE"
fi
NAME="${MO_VERSION_NAME:-}"
[ -n "$NAME" ] || NAME="$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const m=s.match(/versionName "([^"]+)"/);console.log(m?m[1]:"")' "$GRADLE")"

node - "$GRADLE" "$CODE" "$NAME" <<'NODE'
const fs = require("fs");
const [file, code, name] = process.argv.slice(2);
let s = fs.readFileSync(file, "utf8");
s = s.replace(/versionCode \d+/, "versionCode " + code);
if (name) s = s.replace(/versionName "[^"]*"/, 'versionName "' + name + '"');
fs.writeFileSync(file, s);
NODE

printf '{"versionCode":%d,"versionName":"%s","builtAt":"%s"}\n' "$CODE" "$NAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > app/web/build-info.json

( cd app && npx cap sync android )

# 每次 versionCode 变化都改 SW 缓存名，旧 APK 的 SW 才会安装新版本并重新缓存资源。
SW="app/android/app/src/main/assets/public/sw.js"
if [ -f "$SW" ]; then
  node -e "const fs=require('fs');const p='$SW';fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace(/mo-agent-v[0-9]+/g,'mo-agent-v$CODE'))"
  echo "[build] SW cache -> mo-agent-v$CODE"
fi

( cd app/android && ./gradlew "${GRADLE_TASK:-assembleDebug}" --no-daemon )

APK="app/android/app/build/outputs/apk/debug/app-debug.apk"
cp app/web/build-info.json "app/android/app/build/outputs/apk/debug/version.json" 2>/dev/null || true

echo "[build] 产物: $APK"
ls -la "$APK"
echo "[build] 安装: adb install -r $APK"
