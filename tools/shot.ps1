Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Capture an explicit rectangle: x y w h, so the crop can be aligned to the
# exact bounds the Electron window reports instead of guessing at a corner.
$x = [int]$args[0]
$y = [int]$args[1]
$w = [int]$args[2]
$h = [int]$args[3]

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
$bmp.Save($args[4], [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "saved $($args[4]) rect ${w}x${h} at ${x},${y}"
