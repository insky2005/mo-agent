# 从 GitHub Releases 安装 mo（Windows，不需要源码、不需要 Node）。
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/insky2005/mo-agent/main/installer/get-cli.ps1 | iex"
#   ... 加 -Args '-WithSkill' 顺带装技能（iex 方式不好传参，建议下载后执行）
#   $env:MO_VERSION = "cli-v0.2.0"; ...
#   $env:MO_CLI_BASE_URL = "file://..."; ...   # 本地验证
#
# 只装到用户目录（默认 %USERPROFILE%\.local\bin），不改系统 PATH、不写注册表。
param(
  [string]$Version = $env:MO_VERSION,
  [string]$Repo = $(if ($env:MO_AGENT_REPO) { $env:MO_AGENT_REPO } else { "insky2005/mo-agent" }),
  [string]$BinDir = $(if ($env:MO_BIN_DIR) { $env:MO_BIN_DIR } else { Join-Path $env:USERPROFILE ".local\bin" }),
  [switch]$WithSkill
)

$ErrorActionPreference = "Stop"

$Asset = "mo-windows-x64.exe"

# 解析下载地址：CLI 用 cli-v* 前缀，不能依赖 releases/latest（会被 APK/desktop 的 release 抢走）
function Resolve-AssetUrl {
  $base = $env:MO_CLI_BASE_URL
  if ($base) { return "$base/$Asset" }

  if ($Version) {
    if ($Version -match '^cli-v') { $tag = $Version } else { $tag = "cli-$Version" }
    return "https://github.com/$Repo/releases/download/$tag/$Asset"
  }

  $headers = @{ "User-Agent" = "mo-agent"; "Accept" = "application/vnd.github+json" }
  try {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=30" -Headers $headers
  } catch { return $null }

  foreach ($release in $releases) {
    foreach ($a in $release.assets) {
      if ($a.name -eq $Asset) { return $a.browser_download_url }
    }
  }
  return $null
}

$Url = Resolve-AssetUrl
if (-not $Url) {
  throw "找不到 $Asset 的 release：检查仓库是否公开、是否发过 cli-v* 版本，或指定 -Version cli-v0.2.0"
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("mo-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

try {
  Write-Host "下载 mo…"
  Invoke-WebRequest -Uri $Url -OutFile (Join-Path $Tmp $Asset) -UseBasicParsing

  # 有校验文件就校验
  $ShaUrl = "$Url.sha256"
  try {
    Invoke-WebRequest -Uri $ShaUrl -OutFile (Join-Path $Tmp "$Asset.sha256") -UseBasicParsing
    $Expected = ((Get-Content (Join-Path $Tmp "$Asset.sha256")) -split '\s+')[0].ToLower()
    $Actual = (Get-FileHash (Join-Path $Tmp $Asset) -Algorithm SHA256).Hash.ToLower()
    if ($Expected -ne $Actual) {
      throw "校验和不匹配：期望 $Expected，实际 $Actual"
    }
    Write-Host "✓ 校验和通过"
  } catch {
    if ($_.Exception.Message -like "*校验和不匹配*") { throw }
    Write-Host "（没有发布校验和文件，跳过校验）"
  }

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $Target = Join-Path $BinDir "mo.exe"
  Copy-Item -Force (Join-Path $Tmp $Asset) $Target

  Write-Host ""
  Write-Host "✓ 已安装 $Target"
  & $Target --version

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $Parts = @()
  if ($UserPath) { $Parts = $UserPath.Split(";") | Where-Object { $_ } }
  if ($Parts -notcontains $BinDir) {
    Write-Host ""
    Write-Host "PATH 未包含该目录，当前窗口先执行："
    Write-Host ('  $env:Path = "' + $BinDir + ';$env:Path"')
    Write-Host "要永久生效（只改当前用户）："
    Write-Host ('  [Environment]::SetEnvironmentVariable("Path", "' + $BinDir + ';$env:Path", "User")')
  }

  if ($WithSkill) {
    try { & $Target skill install } catch { Write-Warning "技能安装失败：$_" }
  }

  Write-Host ""
  Write-Host "下一步："
  Write-Host "  mo setup                 首次装配（幂等）；先看会做什么：mo setup --dry-run"
  Write-Host "  mo doctor                自检"
  Write-Host "  mo project init          在项目目录初始化 .mo-agent/"
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
