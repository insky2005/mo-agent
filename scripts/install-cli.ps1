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
Write-Host "  mo setup                 首次装配（幂等）：配置、记忆、默认执行者/终端、技能、MCP"
Write-Host "                           先看会做什么：mo setup --dry-run"
Write-Host "  mo doctor                自检"
Write-Host "  mo project init          在项目目录初始化 .mo-agent/"
