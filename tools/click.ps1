Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

# Optional: remember where the cursor was so it can be put back.
$orig = [System.Windows.Forms.Cursor]::Position

$before = [M]::GetForegroundWindow()
[M]::SetCursorPos([int]$args[0], [int]$args[1])
Start-Sleep -Milliseconds 200
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds 60
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
Start-Sleep -Milliseconds 400
$after = [M]::GetForegroundWindow()

if ($args.Count -ge 3 -and $args[2] -eq "restore") {
  [M]::SetCursorPos($orig.X, $orig.Y)
}

Write-Output "clicked $($args[0]),$($args[1]); foreground $before -> $after"
