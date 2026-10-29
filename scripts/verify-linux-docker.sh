#!/usr/bin/env bash
# 在 Linux 容器里跑跨平台 CLI 的基础验收。
#
#   bash scripts/verify-linux-docker.sh
#   MO_VERIFY_IMAGE=node:22.12-bookworm bash scripts/verify-linux-docker.sh
#
# 只验证 Linux（CLI / setup / 配置 / 记忆 / MCP / daemon 接口）。
# Windows 不能用这个脚本验证。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${MO_VERIFY_IMAGE:-node:22-bookworm}"

command -v docker >/dev/null 2>&1 || {
  echo "需要 docker" >&2
  exit 1
}

echo "镜像: ${IMAGE}"
echo "仓库: ${ROOT}"
echo

tar -C "${ROOT}" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=cli/dist \
  --exclude=.mo-agent \
  --exclude=.DS_Store \
  -cf - . \
| docker run -i --rm -w /work \
    -e HOME=/tmp/mo-home \
    -e MO_AGENT_HOME=/tmp/mo-home/.mo-agent \
    "${IMAGE}" bash -lc '
      set -euo pipefail
      mkdir -p /work "$HOME"
      tar -xf - -C /work
      cd /work

      npm ci --no-audit --no-fund
      npm test
      npm run check

      node cli/mo.mjs doctor
      node cli/mo.mjs config set port 7799
      node cli/mo.mjs config get port
      node cli/mo.mjs memory init --json
    '

echo
echo "✅ Linux 基础验收通过（不包含终端开窗 / 语音 / 手机推送）"
