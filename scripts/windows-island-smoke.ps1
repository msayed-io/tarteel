param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)

$ErrorActionPreference = 'Stop'
$outDir = Join-Path $env:GITHUB_WORKSPACE 'artifacts/island-ui-smoke'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$statusPath = Join-Path $outDir 'status.txt'
$logPath = Join-Path $env:APPDATA 'com.tarteel.desktop/island-geometry.jsonl'
$process = $null

function Set-Status([string]$Value) {
  Set-Content -Path $statusPath -Value $Value -Encoding UTF8
  Write-Host "ISLAND_UI_SMOKE_STATUS=$Value"
}

function Get-Rows {
  if (-not (Test-Path $logPath)) { return @() }
  $rows = @()
  foreach ($line in (Get-Content -Path $logPath -ErrorAction SilentlyContinue)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try { $rows += ($line | ConvertFrom-Json) } catch { Write-Warning "Ignoring malformed geometry JSONL row: $($_.Exception.Message)" }
  }
  return $rows
}

function Wait-ForRow([string]$State, [int]$TimeoutSeconds, [Nullable[long]]$After = $null, [switch]$Expanded) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $rows = Get-Rows
    $matches = @($rows | Where-Object {
      if ($_.state -ne $State -or ($null -ne $After -and [long]$_.timestamp_unix_ms -le $After)) { return $false }
      if ($null -eq $_.capsule_rect_client) { return $false }
      $capsuleHeight = [double]$_.capsule_rect_client.bottom - [double]$_.capsule_rect_client.top
      $compactHeight = 26.0 * [double]$_.scale_factor
      if ($Expanded) { return $capsuleHeight -gt $compactHeight }
      return $capsuleHeight -le $compactHeight
    })
    if ($matches.Count -gt 0) { return $matches[-1] }
    if ($process -and $process.HasExited) { throw "Tarteel exited early with code $($process.ExitCode) while waiting for state '$State'" }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for a measured '$State' state in $logPath"
}

function Click-RectCenter($Record) {
  $rect = $Record.capsule_rect_screen
  if ($null -eq $rect) { throw "State '$($Record.state)' has no measured capsule rectangle" }
  $x = [int][Math]::Round(([double]$rect.left + [double]$rect.right) / 2.0)
  $y = [int][Math]::Round(([double]$rect.top + [double]$rect.bottom) / 2.0)
  if (-not [TarteelUiSmokeNative]::SetCursorPos($x, $y)) { throw "SetCursorPos failed at ($x,$y)" }
  Start-Sleep -Milliseconds 100
  [TarteelUiSmokeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 70
  [TarteelUiSmokeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host "Sent physical mouse click at measured capsule center ($x,$y) for $($Record.state)."
}

function Capture-Top([string]$Name) {
  $screenWidth = [TarteelUiSmokeNative]::GetSystemMetrics(0)
  $screenHeight = [TarteelUiSmokeNative]::GetSystemMetrics(1)
  if ($screenWidth -le 0 -or $screenHeight -le 0) { throw 'No active display dimensions are available to capture.' }
  $height = [Math]::Min($screenHeight, 420)
  $bitmap = New-Object System.Drawing.Bitmap($screenWidth, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
    $path = Join-Path $outDir "$Name.png"
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Captured $path ($screenWidth x $height)."
    return $path
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Assert-BlackCapsuleCenter($Record, [string]$ScreenshotPath) {
  $rect = $Record.capsule_rect_screen
  $cx = [int][Math]::Round(([double]$rect.left + [double]$rect.right) / 2.0)
  $cy = [int][Math]::Round(([double]$rect.top + [double]$rect.bottom) / 2.0)
  $bitmap = [System.Drawing.Bitmap]::FromFile($ScreenshotPath)
  try {
    if ($cx -lt 0 -or $cx -ge $bitmap.Width -or $cy -lt 0 -or $cy -ge $bitmap.Height) { throw "Measured capsule center ($cx,$cy) is outside captured image $($bitmap.Width)x$($bitmap.Height)." }
    $color = $bitmap.GetPixel($cx, $cy)
    Write-Host "Capsule-center screenshot pixel: R=$($color.R), G=$($color.G), B=$($color.B)."
    if ([Math]::Max([Math]::Max($color.R, $color.G), $color.B) -gt 55) { throw "The capsule center pixel is not dark; the screenshot does not confirm the measured capsule at ($cx,$cy)." }
  } finally {
    $bitmap.Dispose()
  }
}

function Assert-Anchor($Record) {
  $rect = $Record.capsule_rect_screen
  $anchor = $Record.capsule_anchor_center_screen
  $monitor = $Record.monitor_rc_monitor
  if ($null -eq $rect -or $null -eq $anchor -or $null -eq $monitor) { throw 'Geometry record is missing a capsule, anchor, or monitor rectangle.' }
  $cx = ([double]$rect.left + [double]$rect.right) / 2.0
  $cy = ([double]$rect.top + [double]$rect.bottom) / 2.0
  $dx = $cx - [double]$anchor.x
  $dy = $cy - [double]$anchor.y
  $expectedX = ([double]$monitor.left + [double]$monitor.right) / 2.0
  $expectedY = [double]$monitor.top + 17.0 * [double]$Record.scale_factor
  if ([Math]::Abs([double]$anchor.x - $expectedX) -gt 0.01 -or [Math]::Abs([double]$anchor.y - $expectedY) -gt 0.01) {
    throw "The collapsed anchor is not the monitor-origin stage center. Expected ($expectedX,$expectedY), measured ($($anchor.x),$($anchor.y))."
  }
  if ([Math]::Abs($dx) -gt 0.5 -or [Math]::Abs($dy) -gt 0.5) {
    throw "Capsule center is outside the 0.5 physical-pixel monitor-anchor tolerance: dx=$dx, dy=$dy."
  }
  Write-Host "Verified capsule center against monitor-origin anchor ($($anchor.x),$($anchor.y)): dx=$dx, dy=$dy."
}

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TarteelUiSmokeNative {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
}
'@

try {
  if (-not (Test-Path $ExePath)) { throw "Tarteel executable not found: $ExePath" }
  if ([TarteelUiSmokeNative]::GetSystemMetrics(0) -le 0 -or [TarteelUiSmokeNative]::GetSystemMetrics(1) -le 0) {
    throw 'Windows runner exposes no interactive display; refusing to mark native geometry verification as passed.'
  }
  if (Test-Path $logPath) { Remove-Item -Force $logPath }
  $process = Start-Process -FilePath (Resolve-Path $ExePath) -WorkingDirectory (Split-Path (Resolve-Path $ExePath)) -PassThru
  $idle = Wait-ForRow 'idle' 35
  if ($idle.aligned_within_half_pixel -ne $true) { throw "Idle alignment was not verified: $($idle.aligned_within_half_pixel)" }
  if ($null -eq $idle.capsule_rect_screen -or $null -eq $idle.capsule_anchor_center_screen) { throw 'Idle row did not include measured capsule and monitor-origin anchor coordinates.' }
  if ($null -eq $idle.pre_alignment -or $null -eq $idle.pre_alignment.capsule_center_error_from_anchor_px) { throw 'The idle row did not preserve the measured capsule offset before correction.' }
  Assert-Anchor $idle
  $idleShot = Capture-Top 'idle-before-click'
  Assert-BlackCapsuleCenter $idle $idleShot
  Copy-Item -Force $logPath (Join-Path $outDir 'geometry-after-idle.jsonl')

  Click-RectCenter $idle
  $prayer = Wait-ForRow 'prayer' 15 ([long]$idle.timestamp_unix_ms) -Expanded
  if ($prayer.client_size.width -lt 300 -or $prayer.client_size.height -lt 100) { throw "Prayer state did not expand the native window as expected: $($prayer.client_size.width)x$($prayer.client_size.height)" }
  if ($prayer.aligned_within_half_pixel -ne $true) { throw "Expanded window origin did not align to the monitor origin: $($prayer.aligned_within_half_pixel)" }
  $null = Capture-Top 'prayer-expanded'

  Click-RectCenter $prayer
  $collapsed = Wait-ForRow 'idle' 15 ([long]$prayer.timestamp_unix_ms)
  if ($collapsed.aligned_within_half_pixel -ne $true) { throw "Collapsed capsule is outside the 0.5px monitor-anchor tolerance: $($collapsed.capsule_center_error_from_anchor_px | ConvertTo-Json -Compress)" }
  Assert-Anchor $collapsed
  $collapsedShot = Capture-Top 'idle-after-collapse'
  Assert-BlackCapsuleCenter $collapsed $collapsedShot
  Copy-Item -Force $logPath (Join-Path $outDir 'geometry-final.jsonl')

  $summary = @(
    'PASS: launched the built Tarteel Windows executable.',
    "PASS: measured idle capsule offset before correction=$($idle.pre_alignment.capsule_center_error_from_anchor_px | ConvertTo-Json -Compress); after correction=$($collapsed.capsule_center_error_from_anchor_px | ConvertTo-Json -Compress).",
    'PASS: physical mouse click opened prayer state and the native window expanded.',
    'PASS: physical mouse click returned to idle and the measured capsule remained centered.',
    "Display: $($collapsed.monitor_rc_monitor.right - $collapsed.monitor_rc_monitor.left)x$($collapsed.monitor_rc_monitor.bottom - $collapsed.monitor_rc_monitor.top); scale_factor=$($collapsed.scale_factor); native_dpi=$($collapsed.native_dpi)."
  )
  Set-Content -Path (Join-Path $outDir 'summary.txt') -Value $summary -Encoding UTF8
  Set-Status 'PASS'
} catch {
  Set-Status 'FAIL'
  Write-Error $_
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path $logPath) { Copy-Item -Force $logPath (Join-Path $outDir 'geometry-final.jsonl') }
}
