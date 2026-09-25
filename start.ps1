<#
  巴别回声 启动脚本
  用法:  .\start.ps1 [端口]       默认 8777
#>
param([int]$Port = 8777)

Set-Location -LiteralPath $PSScriptRoot

# node.exe 不一定在 PATH 上，兼容默认 Windows 安装位置。
$candidates = @()
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $candidates += $found.Source }
$candidates += @("$env:ProgramFiles\nodejs\node.exe")
$node = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $node) {
  Write-Host "找不到 node.exe，请先安装 Node.js 20 或更高版本。" -ForegroundColor Red
  exit 1
}

# 端口不能落在 Windows 的 Hyper-V 排除范围里，否则会报 EACCES。
$excluded = netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
if ($excluded -match "(?m)^\s*(\d+)\s+(\d+)" ) { }
$blocked = $false
foreach ($line in $excluded) {
  if ($line -match '^\s*(\d+)\s+(\d+)\s*\*?\s*$') {
    if ($Port -ge [int]$Matches[1] -and $Port -le [int]$Matches[2]) { $blocked = $true }
  }
}
if ($blocked) {
  Write-Host "端口 $Port 在 Windows 排除范围内（Hyper-V/WSL 保留），换一个端口，例如 8777。" -ForegroundColor Yellow
  exit 1
}

Write-Host "启动 巴别回声（端口 $Port）..." -ForegroundColor Cyan
& $node server.mjs $Port
