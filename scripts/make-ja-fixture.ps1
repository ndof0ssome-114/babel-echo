<#
  make-ja-fixture.ps1 — synthesize a Japanese meeting fixture.
  ---------------------------------------------------------------
  用 Windows 自带的日语 SAPI 语音（Haruka/Ichiro）合成测试音频。

  为什么不用 MiMo TTS：本项目实测发现 MiMo-V2.5-TTS **不会说日语**，
  把日文文本按中文音素念出来。用它做「日语识别测试」会污染结论——
  识别模型再准，输入也不是日语。所以这里换成真正的日语合成引擎。

  用法: powershell -File .\scripts\make-ja-fixture.ps1
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\.probe\ja-fixture'),
  [string]$Voice  = 'Microsoft Haruka Desktop'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Add-Type -AssemblyName System.Speech

$lines = @(
  'こんにちは、田中です。今日の会議では、来月の新製品発表について話し合います。',
  '私は王と申します。予算は三十万円ほど残っています。広告に使うことを提案します。',
  'なるほど。では来週の金曜日までに、詳細な計画書を送ってください。'
)

$norm = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  $raw = Join-Path $OutDir ("sapi-raw-" + $i + ".wav")
  $fixed = Join-Path $OutDir ("sapi-norm-" + $i + ".wav")
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($Voice)
  $synth.Rate = 0
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($raw)
  $synth.Speak($lines[$i])
  $synth.SetOutputToNull()
  $synth.Dispose()
  & ffmpeg -y -loglevel error -i $raw -ac 1 -ar 16000 -acodec pcm_s16le $fixed
  $norm += $fixed
  Write-Host ("  line " + ($i + 1) + " ok")
}

$silence = Join-Path $OutDir 'sapi-silence.wav'
& ffmpeg -y -loglevel error -f lavfi -i 'anullsrc=r=16000:cl=mono' -t 1.2 -acodec pcm_s16le $silence

$listPath = Join-Path $OutDir 'sapi-list.txt'
$entries = @()
foreach ($n in $norm) {
  $entries += "file '" + ($n -replace '\\', '/') + "'"
  $entries += "file '" + ($silence -replace '\\', '/') + "'"
}
# PowerShell 5.1's -Encoding UTF8 writes a BOM, and ffmpeg's concat demuxer
# rejects the very first line as "unknown keyword 'file'". Write BOM-less text.
[System.IO.File]::WriteAllLines($listPath, [string[]]$entries, [System.Text.Encoding]::ASCII)

$final = Join-Path $OutDir 'ja-meeting-sapi.wav'
& ffmpeg -y -loglevel error -f concat -safe 0 -i $listPath -acodec pcm_s16le $final

if (-not (Test-Path $final)) { throw "ffmpeg failed to build $final" }

$dur = (& ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 $final | Out-String).Trim()
Write-Host ("voice  : " + $Voice)
Write-Host ("output : " + $final)
Write-Host ("length : " + $dur + " s")
