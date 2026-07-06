# 炉石二期 · 一键内联打包
# 把 assets/art 下所有插画编成 window.__ART__ 的 data URI 映射，注入 </body> 前，
# 产出单文件 hearthstone-lite.dist.html（双击即玩、可整包分发）。
# 插画在内联时降采样到 512 并转 JPEG（卡面最大显示约 88px，512 足够清晰），大幅缩小体积；
# 处理失败的图回退为原始 PNG data URI。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # hearthstone-lite/
$srcHtml = Join-Path $root "hearthstone-lite.html"
$distHtml = Join-Path $root "hearthstone-lite.dist.html"
$artDir = Join-Path $root "assets\art"

Add-Type -AssemblyName System.Drawing

# 把一张图缩放并编码：优先 512px JPEG，失败回退原 PNG
function Encode-Art([string]$path) {
  try {
    $img = [System.Drawing.Image]::FromFile($path)
    $max = 512
    $scale = [Math]::Min(1.0, $max / [Math]::Max($img.Width, $img.Height))
    $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $w, $h)
    $g.Dispose(); $img.Dispose()
    # JPEG 质量 82
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]82)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, $enc, $ep); $bmp.Dispose()
    $b64 = [System.Convert]::ToBase64String($ms.ToArray()); $ms.Dispose()
    return "data:image/jpeg;base64,$b64"
  } catch {
    $b64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path))
    return "data:image/png;base64,$b64"
  }
}

$pairs = @()
Get-ChildItem $artDir -Filter *.png | ForEach-Object {
  $id = $_.BaseName
  $uri = Encode-Art $_.FullName
  # JSON 安全：id 全为 [A-Za-z0-9_]，data URI 为 base64，均无需转义，直接拼
  $pairs += '"' + $id + '":"' + $uri + '"'
}
$artJs = "<script>window.__ART__={" + ($pairs -join ",") + "};</script>"

$html = Get-Content $srcHtml -Raw -Encoding UTF8
$html = $html -replace "</body>", ($artJs + "`r`n</body>")
[System.IO.File]::WriteAllText($distHtml, $html, [System.Text.UTF8Encoding]::new($false))

$mb = [math]::Round((Get-Item $distHtml).Length/1MB, 2)
"内联完成：$($pairs.Count) 张插画 -> $distHtml ($mb MB)"
