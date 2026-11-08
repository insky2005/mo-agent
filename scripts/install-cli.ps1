# 安装 mo CLI（Windows）。
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1 -Source .\cli\dist\mo.exe
#   powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1 -Uninstall
#
# 只装到用户目录（默认 %USERPROFILE%\.local\bin），不改系统 PATH、不写注册表、
# 不申请管理员权限。构建产物需在 Windows 上生成（不交叉编译）。
param(
  [string]$BinDir = "",
  [string]$Source = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$homeDir = if ($env:MO_AGENT_HOME) { $env:MO_AGENT_HOME } else { Join-Path $env:USERPROFILE ".mo-agent" }
$record = Join-Path $homeDir "install.json"
if (-not $BinDir) { $BinDir = Join-Path $env:USERPROFILE ".local\bin" }
$target = Join-Path $BinDir "mo.exe"

if ($Uninstall) {
  if (Test-Path $target) {
    Remove-Item -Force $target
    Write-Host "已移除 $target"
  }
  if (Test-Path $record) { Remove-Item -Force $record }
  Write-Host "PATH 里的目录没有动；需要的话自己删掉 $BinDir"
  exit 0
}

if (-not $Source) {
  $built = Join-Path $root "cli\dist\mo.exe"
  if (Test-Path $built) {
    $Source = $built
  } else {
    throw "找不到 $built。请先在 Windows 上构建：bun build --compile --minify cli/mo.mjs --outfile cli/dist/mo.exe，或用 -Source 指定 mo.exe"
  }
}
if (-not (Test-Path $Source)) { throw "找不到安装源：$Source" }

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Copy-Item -Force $Source $target
New-Item -ItemType Directory -Force -Path $homeDir | Out-Null

$recordData = [ordered]@{
  mode = "binary"
  bin = $target
  entry = (Join-Path $root "cli\mo.mjs")
  at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$recordData | ConvertTo-Json | Set-Content -Encoding UTF8 $record

Write-Host "已安装：$target（binary）"
try {
  & $target --version | ForEach-Object { Write-Host "✓ mo $_" }
} catch {
  Write-Warning "安装完成，但执行 mo --version 失败：$_"
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @()
if ($userPath) { $parts = $userPath.Split(";") | Where-Object { $_ } }
if ($parts -notcontains $BinDir) {
  Write-Host ""
  Write-Host 'PATH 未包含该目录，当前窗口先执行：'
  Write-Host ('  $env:Path = "' + $BinDir + ';$env:Path"')
  Write-Host '要永久生效（只改当前用户）：'
  Write-Host ('  [Environment]::SetEnvironmentVariable(''Path'', "' + $BinDir + ';$env:Path", ''User'')')
}

Write-Host ""
Write-Host "下一步："
Write-Host "  mo setup         首次装配（幂等）：配置、记忆、默认执行者/终端、技能、MCP"
Write-Host "                   会问要不要配指挥台（那一步要下载约 150MB，可以说不）"
Write-Host "                   先看它会做什么：mo setup --dry-run"
Write-Host "  mo doctor        自检；最后一行会告诉你「下一步做什么」"
Write-Host ""
Write-Host "先选一条路（随时可以换）："
Write-Host "  只看不改         装桌面 App + 手机（Windows 版适配中）：收通知、远程批准"
Write-Host "  接外部 Agent     mo connect describe    提示词 / MCP / 技能三种接法"
Write-Host "  用内置指挥台     mo router start        mo 自己的主 Agent，只分派不动手"
Write-Host "  只敲命令         看下面这段"
Write-Host ""
Write-Host "基本用法（在项目目录里）："
Write-Host "  mo project create    认领当前目录：写 .mo-agent/ 与 Agent 说明"
Write-Host "  mo worker list       看可用执行者（裸名=会话，-headless=无头）"
Write-Host '  mo task create --title hello --deliverable "x" --verify "run:echo hi" --worker claude-headless'
Write-Host "  mo task show <id>    状态 / 验收 / 待批 / 结论"
Write-Host "  mo task dispatch <id> --detach    批准后后台派单（手机也能点「允许并派单」）"
Write-Host "  mo inbox pull        收结果；也可以等手机通知"
Write-Host ""
Write-Host "没在 create 时批准：mo task confirm <id> 发起请求，手机或终端批准后再 dispatch"
Write-Host "命令以 mo help 为准（mo help --all 看全部分组，mo help <组> 看细节）。"
