#!/usr/bin/env bash
# 彻底卸载 mo-agent 桌面版：停进程 → 删 App → 删安装状态 → 删日志 → 刷新 LaunchServices。
#
# 用终端而不是 Finder 的「移到废纸篓」：Finder 会做占用检查并可能拒绝，
# 而且删除失败时往往不给原因。这个脚本会逐项报告成功/失败与诊断线索。
set -uo pipefail

APP_DIR="${MO_AGENT_APP_DIR:-$HOME/Applications}"
DEST="$APP_DIR/mo-agent.app"
# 历史遗留：早期装到 /Applications，也一并清理
LEGACY="/Applications/mo-agent.app"
CACHE="$HOME/Library/Application Support/dev.moagent.desktop"
LOGS="$HOME/Library/Logs/mo-agent"

echo "[uninstall] 停止运行中的实例"
pkill -f "mo-agent.app/Contents/MacOS/" 2>/dev/null || true
pkill -f "host/index.mjs" 2>/dev/null || true
sleep 1
pkill -9 -f "mo-agent.app/Contents/MacOS/" 2>/dev/null || true
pkill -9 -f "host/index.mjs" 2>/dev/null || true
sleep 1

failed=0
remove() {
  local p="$1"
  if [ ! -e "$p" ]; then
    echo "  跳过（本来就没有）: $p"
    return 0
  fi
  if rm -rf "$p" 2>/dev/null; then
    echo "  已删除: $p"
    return 0
  fi
  echo "  删除失败: $p" >&2
  echo "    权限/标志: $(ls -ldO "$p" 2>&1 | head -1)" >&2
  echo "    ACL:       $(ls -lde "$p" 2>&1 | sed -n 2p)" >&2
  echo "    先试: chflags -R nouchg \"$p\" && chmod -R u+w \"$p\" && rm -rf \"$p\"" >&2
  failed=1
  return 1
}

echo "[uninstall] 删除文件"
remove "$LEGACY" || true
remove "$DEST" || true
remove "$CACHE" || true
remove "$LOGS" || true

echo "[uninstall] 刷新 LaunchServices 登记（清掉 Finder 里的残影图标）"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREG" ]; then
  "$LSREG" -u "$DEST" >/dev/null 2>&1 || true
  echo "  已注销 $DEST"
fi

if [ "$failed" = "0" ]; then
  echo "[uninstall] 完成 —— 全部清理干净"
else
  echo "[uninstall] 有项目删除失败，按上面的提示处理" >&2
  exit 1
fi

