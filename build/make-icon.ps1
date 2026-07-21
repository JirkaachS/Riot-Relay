# Generates build/icon.png (256) and build/icon.ico for Riot Relay.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$S = 256
$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# Dense graphite tile with a restrained ice-blue relay accent.
$bg = New-RoundedPath 3 3 250 250 48
$bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 12, 13, 17))
$bgBorder = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 48, 51, 60)), 3
$g.FillPath($bgBrush, $bg)
$g.DrawPath($bgBorder, $bg)

# Offset cards imply identities moving through one secure relay, without arrows.
$rear = New-RoundedPath 54 45 137 121 20
$rearPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 70, 75, 87)), 9
$rearPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$g.DrawPath($rearPen, $rear)
$accentPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 92, 184, 220)), 9
$accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$accentPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($accentPen, 78, 66, 158, 66)

$front = New-RoundedPath 67 81 137 132 20
$frontBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 24, 26, 32))
$frontPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 97, 102, 116)), 6
$g.FillPath($frontBrush, $front)
$g.DrawPath($frontPen, $front)

# Custom R-shaped relay track: one continuous identity path and one hand-off node.
$markPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 228, 231, 238)), 15
$markPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$markPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$markPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$g.DrawLine($markPen, 103, 113, 103, 181)
$g.DrawArc($markPen, 96, 105, 67, 55, 270, 180)
$g.DrawLine($markPen, 137, 154, 164, 184)
$nodeBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 92, 184, 220))
$g.FillEllipse($nodeBrush, 151, 174, 20, 20)

$g.Dispose()
$pngPath = Join-Path $here 'icon.png'
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# Build a true multi-resolution ICO so Windows can select a native taskbar,
# shortcut, tray, or high-DPI size instead of displaying Electron's fallback.
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
  if ($size -eq 256) {
    $images += ,([System.IO.File]::ReadAllBytes($pngPath))
    continue
  }
  $scaled = New-Object System.Drawing.Bitmap $size, $size
  $sg = [System.Drawing.Graphics]::FromImage($scaled)
  $sg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sg.DrawImage($bmp, 0, 0, $size, $size)
  $stream = New-Object System.IO.MemoryStream
  $scaled.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $images += ,($stream.ToArray())
  $stream.Dispose(); $sg.Dispose(); $scaled.Dispose()
}
$bmp.Dispose()

$icoPath = Join-Path $here 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dimension = if ($sizes[$i] -eq 256) { [Byte]0 } else { [Byte]$sizes[$i] }
  $bw.Write($dimension)
  $bw.Write($dimension)
  $bw.Write([Byte]0)
  $bw.Write([Byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$images[$i].Length)
  $bw.Write([UInt32]$offset)
  $offset += $images[$i].Length
}
foreach ($image in $images) { $bw.Write($image) }
$bw.Flush(); $bw.Close(); $fs.Close()

$bg.Dispose(); $bgBrush.Dispose(); $bgBorder.Dispose()
$rear.Dispose(); $rearPen.Dispose(); $accentPen.Dispose()
$front.Dispose(); $frontBrush.Dispose(); $frontPen.Dispose()
$markPen.Dispose(); $nodeBrush.Dispose()
Write-Host "ICON_OK $pngPath ($($sizes.Count) ICO sizes)"