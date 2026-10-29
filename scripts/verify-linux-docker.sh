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
# package-lock 里混了内网 Nexus 地址；容器里没有凭据，先改写成公开源
NPM_REGISTRY="${MO_VERIFY_NPM_REGISTRY:-https://registry.npmmirror.com}"

command -v docker >/dev/null 2>&1 || {
  echo "需要 docker" >&2
  exit 1
}

echo "镜像: ${IMAGE}"
echo "仓库: ${ROOT}"
echo

TAR_ARGS=(
  --exclude=.git
  --exclude=node_modules
  --exclude=cli/dist
  --exclude=.mo-agent
  --exclude=.DS_Store
)
# macOS bsdtar 会把 xattr 写成扩展头，Linux 上刷一屏警告
if tar --help 2>/dev/null | grep -q -- "--no-xattrs"; then
  TAR_ARGS+=(--no-xattrs)
fi

tar -C "${ROOT}" "${TAR_ARGS[@]}" -cf - . \
| docker run -i --rm -w /work \
    -e HOME=/tmp/mo-home \
    -e MO_AGENT_HOME=/tmp/mo-home/.mo-agent \
    -e NPM_REGISTRY="${NPM_REGISTRY}" \
    "${IMAGE}" bash -lc '
      set -euo pipefail
      mkdir -p /work "$HOME" "$MO_AGENT_HOME"
      tar --warning=no-unknown-keyword -xf - -C /work
      cd /work

      # 内网 Nexus 的地址在容器里没有凭据，统一改到可访问的源
      sed -E -i "s|https://app\.example\.com/nexus/repository/sw-npm|$NPM_REGISTRY|g; s|https://registry\.npmmirror\.com|$NPM_REGISTRY|g" package-lock.json
      npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"
      npm test
      npm run check

      node cli/mo.mjs doctor
      node cli/mo.mjs config set port 7799
      node cli/mo.mjs config get port
      node cli/mo.mjs memory init --json
    '

echo
echo "✅ Linux 基础验收通过（不包含终端开窗 / 语音 / 手机推送）"