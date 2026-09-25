<#
  妙记 · 免安装桌面模式
  ---------------------------------------------------------------
  用 Chrome / Edge 的 --app 模式开一个没有地址栏、没有标签页的
  独立窗口，看起来就是一个桌面应用，但**不需要下载 Electron**。

  真正的 Electron 版本在 .\desktop\ 下，功能更全（全局快捷键、
  防休眠、托盘、原生通知）。两者共用同一套网页界面。

  用法:  .\start-app.ps1 [端口]        默认 8777
#>
param([int]$Port = 8777)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Find-Exe {
  param([string[]]$Candidates)
  foreach ($c in $Candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

$node = Find-Exe @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
  "$env:ProgramFiles\nodejs\node.exe"
)
if (-not $node) {
  Write-Host '找不到 node.exe，请先安装 Node.js 20 或更高版本。' -ForegroundColor Red
  exit 1
}

$browser = Find-Exe @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
if (-not $browser) {
  Write-Host '找不到 Chrome 或 Edge。请改用 Electron 版本： cd desktop; npm install; npm start' -ForegroundColor Yellow
  exit 1
}

# 端口若落在 Windows 排除范围内，绑定会报 EACCES，先查一下。
$excluded = netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
foreach ($line in $excluded) {
  if ($line -match '^\s*(\d+)\s+(\d+)\s*\*?\s*$') {
    if ($Port -ge [int]$Matches[1] -and $Port -le [int]$Matches[2]) {
      Write-Host "端口 $Port 在 Windows 保留范围内，请换一个，例如 8777。" -ForegroundColor Yellow
      exit 1
    }
  }
}

$log = Join-Path $env:TEMP 'miaoji-server.out.log'
$err = Join-Path $env:TEMP 'miaoji-server.err.log'
Remove-Item $log, $err -ErrorAction SilentlyContinue

Write-Host "启动本地服务（端口 $Port）..." -ForegroundColor Cyan
$server = Start-Process -FilePath $node -ArgumentList @("$PSScriptRoot\server.mjs", "$Port") `
  -WorkingDirectory $PSScriptRoot -RedirectStandardOutput $log -RedirectStandardError $err `
  -PassThru -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-Path $log) {
    $hit = Select-String -Path $log -Pattern 'MIAOJI_READY' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) {
      try { $url = ($hit.Line -replace '^MIAOJI_READY ', '' | ConvertFrom-Json).url } catch { }
      if ($url) { break }
    }
  }
  if ($server.HasExited) { break }
}

if (-not $url) {
  Write-Host '服务启动失败，日志如下：' -ForegroundColor Red
  if (Test-Path $err) { Get-Content $err -Tail 20 }
  if (Test-Path $log) { Get-Content $log -Tail 20 }
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  exit 1
}

Write-Host "服务就绪：$url" -ForegroundColor Green
Write-Host '正在打开应用窗口（关闭窗口即退出）...' -ForegroundColor Cyan

# 用独立的 user-data-dir，避免和用户日常浏览器会话互相干扰，
# 也保证 Start-Process 拿到的就是我们这个窗口的进程。
$profileDir = Join-Path $env:LOCALAPPDATA 'Miaoji\browser-profile'
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$browserProc = Start-Process -FilePath $browser -ArgumentList @(
  "--app=$url",
  "--user-data-dir=$profileDir",
  '--window-size=1480,940',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter'
) -PassThru

try { $browserProc.WaitForExit() } catch { }

Write-Host '窗口已关闭，正在停止服务…' -ForegroundColor Cyan
if ($server -and -not $server.HasExited) {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
Write-Host '已退出。' -ForegroundColor Green
