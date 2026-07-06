# 炉石二期 · 批量出图脚本
# 读 assets-gen/card-art.json，调 Forge(127.0.0.1:7600) txt2img 批量出 12卡+2英雄+1战场 -> assets/art/<id>.png
# 用法：先确保 Forge 已加载 dreamshaperXL_v21TurboDPMSDE，双击/pwsh 运行本脚本
# 已存在的图默认跳过，加 -Force 全量重出；加 -Only "GRIZZLY,YETI" 只出指定项
param(
  [switch]$Force,
  [string]$Only = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # hearthstone-lite/
$jsonPath = Join-Path $PSScriptRoot "card-art.json"
$outDir = Join-Path $root "assets\art"
$api = "http://127.0.0.1:7600/sdapi/v1/txt2img"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$cfg = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$onlySet = @()
if ($Only) { $onlySet = $Only.Split(",") | ForEach-Object { $_.Trim() } }

# @formatter:off
# 组装出图任务清单：战场/英雄/卡牌统一成 {id, prompt, seed} 三元组
# @formatter:on
$jobs = @()
$jobs += [pscustomobject]@{ id = "board"; prompt = $cfg.board.prompt; seed = $cfg.board.seed }
foreach ($h in $cfg.heroes) { $jobs += [pscustomobject]@{ id = $h.id; prompt = $h.prompt; seed = $h.seed } }
foreach ($c in $cfg.cards)  { $jobs += [pscustomobject]@{ id = $c.cardId; prompt = $c.prompt; seed = $c.seed } }

$steps = if ($cfg.steps) { $cfg.steps } else { 7 }
$cfgScale = if ($cfg.cfg) { $cfg.cfg } else { 2 }
$w = if ($cfg.width) { $cfg.width } else { 768 }
$hh = if ($cfg.height) { $cfg.height } else { 768 }

$done = 0; $skip = 0; $failList = @()
foreach ($job in $jobs) {
  if ($onlySet.Count -gt 0 -and $onlySet -notcontains $job.id) { continue }
  $outPath = Join-Path $outDir ($job.id + ".png")
  if ((Test-Path $outPath) -and -not $Force) { "SKIP  $($job.id) (已存在)"; $skip++; continue }

  $fullPrompt = $job.prompt + ", " + $cfg.styleSuffix
  $body = @{
    prompt = $fullPrompt
    negative_prompt = $cfg.negative
    steps = $steps; cfg_scale = $cfgScale; width = $w; height = $hh; seed = $job.seed
    sampler_name = "DPM++ SDE"; scheduler = "Karras"
  } | ConvertTo-Json
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-RestMethod -Uri $api -Method Post -Body $body -ContentType "application/json" -TimeoutSec 300
    [System.IO.File]::WriteAllBytes($outPath, [System.Convert]::FromBase64String($r.images[0]))
    $sw.Stop()
    "OK    $($job.id)  $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
    $done++
  } catch {
    "FAIL  $($job.id): $($_.Exception.Message)"
    $failList += $job.id
  }
}
""
"===== 完成 出图 $done / 跳过 $skip / 失败 $($failList.Count) ====="
if ($failList.Count -gt 0) { "失败项: " + ($failList -join ", ") }
