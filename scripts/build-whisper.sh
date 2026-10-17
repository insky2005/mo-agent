#!/usr/bin/env bash
# 构建 whisper.cpp（cmake 装在 .build/py，不碰系统目录）并把入口放到 .build/bin/。
# 静态链接：产物只依赖系统库，打包进 .app 时不用再带一堆 dylib。
# 模型默认从 hf-mirror 拉 small-q8_0；base 对中文短指令不够用。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.build/whisper-src"
MODEL="$ROOT/.build/models/ggml-small-q8_0.bin"
BIN_DIR="$ROOT/.build/bin"
CMAKE="$ROOT/.build/py/bin/cmake"

mkdir -p "$ROOT/.build/models" "$BIN_DIR"

if [ ! -f "$SRC/CMakeLists.txt" ]; then
  echo "下载 whisper.cpp 源码…"
  mkdir -p "$SRC"
  curl -L --fail --retry 3 --max-time 600 \
    -o "$ROOT/.build/whisper.cpp.tar.gz" \
    https://codeload.github.com/ggerganov/whisper.cpp/tar.gz/refs/tags/v1.7.4
  tar -xzf "$ROOT/.build/whisper.cpp.tar.gz" -C "$SRC" --strip-components=1
fi

if [ ! -s "$MODEL" ]; then
  echo "下载 ggml-small-q8_0 模型（约 252MB，hf-mirror）…"
  curl -L --fail --retry 3 --max-time 1800 \
    -o "$MODEL.part" \
    https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin
  mv "$MODEL.part" "$MODEL"
fi

if [ ! -x "$CMAKE" ]; then
  echo "安装 workspace 内 cmake（不走 brew）…"
  python3 -m pip install --disable-pip-version-check --no-input \
    --target "$ROOT/.build/py" \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    cmake
fi

export PYTHONPATH="$ROOT/.build/py"
"$CMAKE" -B "$SRC/build" -S "$SRC" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DGGML_METAL=OFF \
  -DBUILD_SHARED_LIBS=OFF
"$CMAKE" --build "$SRC/build" --config Release -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

rm -f "$BIN_DIR/whisper-cli"
cp -f "$SRC/build/bin/whisper-cli" "$BIN_DIR/whisper-cli"
chmod +x "$BIN_DIR/whisper-cli"
echo "built $BIN_DIR/whisper-cli (static)"
