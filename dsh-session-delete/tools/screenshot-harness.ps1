# 截取 DeepSeek Harness 主窗口，用于验证插件在真实界面上的呈现。
#
# 只截 Harness 自己的窗口（不是整个屏幕），避免把桌面上无关内容拍进来。
# 可选地把指针移到窗口内某个相对坐标（用真实 mouse_event 输入，能触发 Chromium 的
# hover），再截一张；还可以只裁剪侧栏那一小块，读图更省。
#
# 注意：本机默认 shell 是 Windows PowerShell 5.1，所以本文件必须以 UTF-8 **带 BOM**
# 保存，否则中文注释会被按 ANSI 解析、把语法搞碎。改动本文件后请执行一次：
#   $t = Get-Content -Raw -Encoding UTF8 $PSCommandPath
#   Set-Content -Path $PSCommandPath -Value $t -Encoding UTF8 -NoNewline
#
# 用法：
#   pwsh -File .\screenshot-harness.ps1 -Out D:\deepseek\.dsh-research\shot.png
#   pwsh -File .\screenshot-harness.ps1 -Out ...\side.png -NoFocus -HoverX 200 -HoverY 283 -CropX 20 -CropY 215 -CropW 280 -CropH 145
param(
    [string]$Out = "D:\deepseek\.dsh-research\harness-window.png",
    [int]$HoverX = -1,
    [int]$HoverY = -1,
    # Skips SetForegroundWindow: for unattended captures that must not steal focus.
    [switch]$NoFocus,
    # Optional crop, in window-relative pixels, so a small region can be read cheaply.
    [int]$CropX = -1,
    [int]$CropY = -1,
    [int]$CropW = 0,
    [int]$CropH = 0,
    # Optional left click at a window-relative point, applied after the hover move.
    [int]$ClickX = -1,
    [int]$ClickY = -1
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    // Absolute pointer moves as genuine input events: Chromium's hover state
    // follows these, where a bare SetCursorPos can be ignored.
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
}
"@

$proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
if (-not $proc) {
    Write-Host "找不到带主窗口的 Harness 进程（可能只有托盘/后台进程）" -ForegroundColor Red
    exit 1
}
$h = $proc.MainWindowHandle
"pid=$($proc.Id) hwnd=$h"

if ([DshWin]::IsIconic($h)) { [DshWin]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 700 }  # SW_RESTORE
if (-not $NoFocus) { [void][DshWin]::SetForegroundWindow($h); Start-Sleep -Milliseconds 700 }

$rect = New-Object DshWin+RECT
[void][DshWin]::GetWindowRect($h, [ref]$rect)
$w = $rect.Right - $rect.Left
$hh = $rect.Bottom - $rect.Top
"window rect: left=$($rect.Left) top=$($rect.Top) ${w}x${hh}"

if ($HoverX -ge 0 -and $HoverY -ge 0) {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    function Move-Pointer([int]$sx, [int]$sy) {
        $nx = [int](($sx * 65535) / ($screen.Width - 1))
        $ny = [int](($sy * 65535) / ($screen.Height - 1))
        [DshWin]::mouse_event(0x8001, [uint32]$nx, [uint32]$ny, 0, [IntPtr]::Zero)   # MOVE | ABSOLUTE
    }
    # Leave first, then walk in over several steps: a single jump can be coalesced away.
    $fromX = $rect.Left + 40; $fromY = $rect.Top + $hh - 40
    $toX = $rect.Left + $HoverX; $toY = $rect.Top + $HoverY
    Move-Pointer $fromX $fromY
    Start-Sleep -Milliseconds 350
    for ($step = 1; $step -le 6; $step++) {
        Move-Pointer ([int]($fromX + ($toX - $fromX) * $step / 6)) ([int]($fromY + ($toY - $fromY) * $step / 6))
        Start-Sleep -Milliseconds 60
    }
    "pointer moved to screen ($toX, $toY) in 6 steps"
    Start-Sleep -Milliseconds 1600
}

if ($ClickX -ge 0 -and $ClickY -ge 0) {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $cx = $rect.Left + $ClickX
    $cy = $rect.Top + $ClickY
    $nx = [int](($cx * 65535) / ($screen.Width - 1))
    $ny = [int](($cy * 65535) / ($screen.Height - 1))
    [DshWin]::mouse_event(0x8001, [uint32]$nx, [uint32]$ny, 0, [IntPtr]::Zero)  # move onto the target first
    Start-Sleep -Milliseconds 250
    [DshWin]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)                      # LEFTDOWN
    Start-Sleep -Milliseconds 60
    [DshWin]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)                      # LEFTUP
    "clicked screen ($cx, $cy)"
    Start-Sleep -Milliseconds 1200
}

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
if ($CropW -gt 0 -and $CropH -gt 0 -and $CropX -ge 0 -and $CropY -ge 0) {
    $clip = New-Object System.Drawing.Rectangle($CropX, $CropY, $CropW, $CropH)
    $cropped = $bmp.Clone($clip, $bmp.PixelFormat)
    $cropped.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $cropped.Dispose()
    "cropped: x=$CropX y=$CropY ${CropW}x${CropH}"
} else {
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
}
$g.Dispose(); $bmp.Dispose()
"saved: $Out ($((Get-Item $Out).Length) bytes)"
