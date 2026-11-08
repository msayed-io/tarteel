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
$previousWebViewArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS

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
      $compactHeight = 24.0 * [double]$_.scale_factor
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
  $expectedY = [double]$monitor.top + 19.0 * [double]$Record.scale_factor
  if ([Math]::Abs([double]$anchor.x - $expectedX) -gt 0.01 -or [Math]::Abs([double]$anchor.y - $expectedY) -gt 0.01) {
    throw "The collapsed anchor is not the monitor-origin stage center. Expected ($expectedX,$expectedY), measured ($($anchor.x),$($anchor.y))."
  }
  if ([Math]::Abs($dx) -gt 0.5 -or [Math]::Abs($dy) -gt 0.5) {
    throw "Capsule center is outside the 0.5 physical-pixel monitor-anchor tolerance: dx=$dx, dy=$dy."
  }
  Write-Host "Verified capsule center against monitor-origin anchor ($($anchor.x),$($anchor.y)): dx=$dx, dy=$dy."
}

function Assert-RenderGutter($Record) {
  $rect = $Record.capsule_rect_client
  $size = $Record.client_size
  $scale = [double]$Record.scale_factor
  if ($null -eq $rect -or $null -eq $size -or $scale -le 0) { throw 'Idle geometry is missing the client bounds needed to verify the transparent render gutter.' }
  $visualWidth = ([double]$rect.right - [double]$rect.left) / $scale
  $visualHeight = ([double]$rect.bottom - [double]$rect.top) / $scale
  if ([Math]::Abs($visualWidth - 44.0) -gt 0.75 -or [Math]::Abs($visualHeight - 24.0) -gt 0.75) {
    throw "The visible idle capsule changed size: $visualWidth x $visualHeight CSS px; expected 44 x 24."
  }
  $left = [double]$rect.left
  $top = [double]$rect.top
  $rightGap = [double]$size.width - [double]$rect.right
  $bottomGap = [double]$size.height - [double]$rect.bottom
  if ($left -lt 1.0 -or $top -lt 1.0 -or $rightGap -lt 1.0 -or $bottomGap -lt 1.0) {
    throw "The visible capsule has no full physical-pixel render gutter: left=$left, top=$top, right=$rightGap, bottom=$bottomGap."
  }
  Write-Host "Verified 44x24 CSS-pixel visible capsule with a >=1 physical-pixel transparent gutter; margins=($left,$top,$rightGap,$bottomGap)."
}

function Assert-ExpandedBoundsContained($Record) {
  $rect = $Record.capsule_rect_client
  $size = $Record.client_size
  if ($null -eq $rect -or $null -eq $size) { throw "Expanded state '$($Record.state)' has no client-space capsule bounds or client size." }
  $left = [double]$rect.left
  $top = [double]$rect.top
  $right = [double]$rect.right
  $bottom = [double]$rect.bottom
  if ($left -lt 0 -or $top -lt 0 -or $right -gt [double]$size.width -or $bottom -gt [double]$size.height) {
    throw "Expanded '$($Record.state)' surface is clipped by the WebView client: capsule=($left,$top)-($right,$bottom), client=$($size.width)x$($size.height)."
  }
  $scale = [double]$Record.scale_factor
  if ($scale -le 0) { throw "Expanded '$($Record.state)' geometry has an invalid scale factor." }
  $bottomGap = ([double]$size.height - $bottom) / $scale
  if ($bottomGap -lt 1.0) { throw "Expanded '$($Record.state)' surface has only $bottomGap CSS px of lower viewport gutter; at least 1 CSS px is required." }
  Write-Host "Verified expanded '$($Record.state)' bounds stay inside the WebView client with $bottomGap CSS px of lower viewport gutter."
}

function Assert-MusicCompactBounds($Record) {
  $rect = $Record.capsule_rect_client
  $scale = [double]$Record.scale_factor
  if ($null -eq $rect -or $scale -le 0) { throw 'Music compact geometry is missing a capsule rectangle or valid scale factor.' }
  $width = ([double]$rect.right - [double]$rect.left) / $scale
  $height = ([double]$rect.bottom - [double]$rect.top) / $scale
  if ([Math]::Abs($width - 112.0) -gt 0.75 -or [Math]::Abs($height - 24.0) -gt 0.75) {
    throw "The visible music compact capsule changed size: $width x $height CSS px; expected 112 x 24."
  }
  Write-Host "Verified visible music compact capsule remains 112x24 CSS px."
}

function Assert-FullStateBounds($Record) {
  Assert-ExpandedBoundsContained $Record
  $rect = $Record.capsule_rect_client
  $scale = [double]$Record.scale_factor
  $width = ([double]$rect.right - [double]$rect.left) / $scale
  $height = ([double]$rect.bottom - [double]$rect.top) / $scale
  if ([Math]::Abs($width - 384.0) -gt 0.75 -or [Math]::Abs($height - 210.0) -gt 0.75) {
    throw "The full player surface changed size: $width x $height CSS px; expected 384 x 210."
  }
  Write-Host "Verified full player surface remains 384x210 CSS px and has a measured lower gutter."
}

function Assert-ClickThroughOutsideCapsule($Record) {
  $window = $Record.window_rect_outer
  $capsule = $Record.capsule_rect_screen
  if ($null -eq $window -or $null -eq $capsule -or $null -eq $Record.window_handle) {
    throw 'Collapsed geometry row is missing the native window/capsule bounds or HWND.'
  }
  $x = [int][Math]::Round([double]$capsule.right + 10)
  $y = [int][Math]::Round(([double]$capsule.top + [double]$capsule.bottom) / 2.0)
  if ($x -ge [double]$window.right -or $y -lt [double]$window.top -or $y -ge [double]$window.bottom) {
    throw 'The measured collapsed HWND has no point outside the capsule available for a native pass-through check.'
  }
  $underlying = [TarteelUiSmokeNative]::WindowFromPoint([TarteelScreenPoint]@{ X = $x; Y = $y })
  if ($underlying -eq [IntPtr]::Zero) { throw "WindowFromPoint returned no target at ($x,$y)." }
  if ($underlying.ToInt64() -eq [long]$Record.window_handle) {
    throw "The collapsed island HWND still wins native hit-testing outside its capsule at ($x,$y)."
  }
  Write-Host "Verified native WindowFromPoint resolves outside the collapsed capsule to HWND $underlying, not the island."
}

function Assert-ClickThroughRoundedCorner($Record) {
  $capsule = $Record.capsule_rect_screen
  if ($null -eq $capsule -or $null -eq $Record.window_handle) { throw 'Collapsed geometry row is missing the island bounds or HWND.' }
  $offset = [int][Math]::Round(5.0 * [double]$Record.scale_factor)
  $x = [int][Math]::Round([double]$capsule.left) + $offset
  $y = [int][Math]::Round([double]$capsule.top) + $offset
  $underlying = [TarteelUiSmokeNative]::WindowFromPoint([TarteelScreenPoint]@{ X = $x; Y = $y })
  if ($underlying -eq [IntPtr]::Zero) { throw "WindowFromPoint returned no target at rounded-corner point ($x,$y)." }
  if ($underlying.ToInt64() -eq [long]$Record.window_handle) {
    throw "The collapsed island HWND still captures a point outside its rounded corner at ($x,$y)."
  }
  Write-Host "Verified native hit-testing passes through the rounded corner at ($x,$y) to HWND $underlying."
}

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct TarteelScreenPoint { public int X; public int Y; }
public static class TarteelUiSmokeNative {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(TarteelScreenPoint point);
}
'@

function Wait-ForWebViewCdpTarget([int]$Port, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2)
      $pages = @($targets | Where-Object { $_.type -eq 'page' -and -not [string]::IsNullOrWhiteSpace($_.webSocketDebuggerUrl) })
      if ($pages.Count -gt 0) {
        $main = @($pages | Where-Object { $_.url -notmatch 'island\.html' })
        if ($main.Count -gt 0) { return $main[0] }
        return $pages[0]
      }
    } catch { }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for the local WebView2 CDP target on port $Port."
}

function Invoke-WebViewCdpExpression($Target, [string]$Expression) {
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $receiveTimeout = $null
  try {
    $socket.ConnectAsync([Uri]$Target.webSocketDebuggerUrl, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $message = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $Expression; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($message)
    $sendSegment = [System.ArraySegment[byte]]::new($bytes)
    $socket.SendAsync($sendSegment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $receiveTimeout = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(12))
    $buffer = [byte[]]::new(8192)
    $builder = [System.Text.StringBuilder]::new()
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    while ([DateTime]::UtcNow -lt $deadline) {
      $receiveSegment = [System.ArraySegment[byte]]::new($buffer)
      $received = $socket.ReceiveAsync($receiveSegment, $receiveTimeout.Token).GetAwaiter().GetResult()
      if ($received.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { throw 'WebView2 CDP closed the connection before returning the evaluation result.' }
      $null = $builder.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count))
      if (-not $received.EndOfMessage) { continue }
      $response = $builder.ToString() | ConvertFrom-Json
      $builder.Clear() | Out-Null
      if ($response.id -ne 1) { continue }
      if ($response.error) { throw "WebView2 CDP evaluation failed: $($response.error.message)" }
      if ($response.result.exceptionDetails) { throw "WebView2 JavaScript evaluation failed: $($response.result.exceptionDetails.text)" }
      return $response.result.result.value
    }
    throw 'Timed out receiving the WebView2 CDP evaluation result.'
  } finally {
    if ($receiveTimeout) { $receiveTimeout.Dispose() }
    if ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      try { $socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'smoke complete', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() } catch { }
    }
    $socket.Dispose()
  }
}

function Set-SmokePlayerState($Target, [string]$FileName) {
  $payload = @{
    state = if ([string]::IsNullOrWhiteSpace($FileName)) { 'idle' } else { 'compact' }
    playing = $false
    fileName = $FileName
    artist = 'Windows smoke'
    cover = $null
    duration = 60
    position = 0
    speed = 1
    sleepMode = 'off'
    sleepMinutes = 0
    prayerAlert = ''
  } | ConvertTo-Json -Compress -Depth 5
  $expression = "if(typeof window.__TAURI_INTERNALS__==='undefined'){'tauri-missing'}else{window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'player-state',payload:$payload}).then(()=> 'emitted')}"
  $result = Invoke-WebViewCdpExpression $Target $expression
  if ($result -ne 'emitted') { throw "Could not emit the smoke-only player-state event through Tauri IPC: $result" }
  Write-Host "Emitted smoke-only player-state event for '$FileName' through the local WebView2 CDP connection."
}

try {
  if (-not (Test-Path $ExePath)) { throw "Tarteel executable not found: $ExePath" }
  if ([TarteelUiSmokeNative]::GetSystemMetrics(0) -le 0 -or [TarteelUiSmokeNative]::GetSystemMetrics(1) -le 0) {
    throw 'Windows runner exposes no interactive display; refusing to mark native geometry verification as passed.'
  }
  if (Test-Path $logPath) { Remove-Item -Force $logPath }
  $portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try { $portProbe.Start(); $cdpPort = [int]$portProbe.LocalEndpoint.Port } finally { $portProbe.Stop() }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  try {
    $process = Start-Process -FilePath (Resolve-Path $ExePath) -WorkingDirectory (Split-Path (Resolve-Path $ExePath)) -PassThru
  } finally {
    if ($null -eq $previousWebViewArgs) { Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue }
    else { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousWebViewArgs }
  }
  $cdpTarget = Wait-ForWebViewCdpTarget $cdpPort 25
  $tauriIpcReady = $false
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    try {
      if ((Invoke-WebViewCdpExpression $cdpTarget "typeof window.__TAURI_INTERNALS__") -eq 'object') { $tauriIpcReady = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $tauriIpcReady) { throw 'Connected to WebView2 CDP, but the Tauri IPC bridge did not become available.' }
  Write-Host "Connected to the local WebView2 CDP target '$($cdpTarget.title)' on port $cdpPort."
  $idle = Wait-ForRow 'idle' 35
  if ($idle.aligned_within_half_pixel -ne $true) { throw "Idle alignment was not verified: $($idle.aligned_within_half_pixel)" }
  if ($null -eq $idle.capsule_rect_screen -or $null -eq $idle.capsule_anchor_center_screen) { throw 'Idle row did not include measured capsule and monitor-origin anchor coordinates.' }
  if ($null -eq $idle.pre_alignment -or $null -eq $idle.pre_alignment.capsule_center_error_from_anchor_px) { throw 'The idle row did not preserve the measured capsule offset before correction.' }
  Assert-Anchor $idle
  Assert-RenderGutter $idle
  $idleShot = Capture-Top 'idle-before-click'
  Assert-BlackCapsuleCenter $idle $idleShot
  Copy-Item -Force $logPath (Join-Path $outDir 'geometry-after-idle.jsonl')

  $music = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Set-SmokePlayerState $cdpTarget 'Smoke test recitation.wav'
    try { $music = Wait-ForRow 'compact' 6 ([long]$idle.timestamp_unix_ms); break }
    catch { if ($attempt -eq 3) { throw }; Write-Warning "Waiting for the smoke player-state event (attempt $attempt): $($_.Exception.Message)"; Start-Sleep -Milliseconds 250 }
  }
  if ($null -eq $music) { throw 'The smoke player-state event did not open music compact mode.' }
  Assert-MusicCompactBounds $music
  Click-RectCenter $music
  $full = Wait-ForRow 'full' 15 ([long]$music.timestamp_unix_ms) -Expanded
  Assert-FullStateBounds $full
  if ($full.aligned_within_half_pixel -ne $true) { throw "Full player window origin did not align to the monitor origin: $($full.aligned_within_half_pixel)" }
  if ($null -eq $full.motion_top_min_screen_css_px -or $null -eq $full.motion_top_max_screen_css_px -or [int]$full.motion_sample_count -lt 4) { throw 'Full player state did not include enough measured animation frames.' }
  $fullMotionSpan = [Math]::Abs([double]$full.motion_top_max_screen_css_px - [double]$full.motion_top_min_screen_css_px)
  if ($fullMotionSpan -gt 0.75) { throw "The full player top edge moved $fullMotionSpan CSS px during expansion; expected a fixed capsule anchor." }
  Write-Host "Verified full player bottom gutter and stable top anchor across $($full.motion_sample_count) animation frames; range=$fullMotionSpan CSS px."
  $null = Capture-Top 'full-expanded'
  Copy-Item -Force $logPath (Join-Path $outDir 'geometry-full.jsonl')

  Click-RectCenter $full
  $musicCollapsed = Wait-ForRow 'compact' 15 ([long]$full.timestamp_unix_ms)
  Assert-MusicCompactBounds $musicCollapsed
  Assert-ClickThroughOutsideCapsule $musicCollapsed
  Assert-ClickThroughRoundedCorner $musicCollapsed
  $musicShot = Capture-Top 'music-compact'
  Set-SmokePlayerState $cdpTarget ''
  $idleAfterMusic = Wait-ForRow 'idle' 15 ([long]$musicCollapsed.timestamp_unix_ms)
  Assert-Anchor $idleAfterMusic
  Assert-RenderGutter $idleAfterMusic

  Click-RectCenter $idleAfterMusic
  $prayer = Wait-ForRow 'prayer' 15 ([long]$idleAfterMusic.timestamp_unix_ms) -Expanded
  if ($prayer.client_size.width -lt 300 -or $prayer.client_size.height -lt 100) { throw "Prayer state did not expand the native window as expected: $($prayer.client_size.width)x$($prayer.client_size.height)" }
  Assert-ExpandedBoundsContained $prayer
  if ($prayer.aligned_within_half_pixel -ne $true) { throw "Expanded window origin did not align to the monitor origin: $($prayer.aligned_within_half_pixel)" }
  if ($null -eq $prayer.motion_top_min_screen_css_px -or $null -eq $prayer.motion_top_max_screen_css_px -or [int]$prayer.motion_sample_count -lt 4) { throw 'Expanded state did not include enough measured animation frames.' }
  $motionSpan = [Math]::Abs([double]$prayer.motion_top_max_screen_css_px - [double]$prayer.motion_top_min_screen_css_px)
  if ($motionSpan -gt 0.75) { throw "Island top moved $motionSpan CSS px during expansion; expected a fixed capsule anchor." }
  Write-Host "Verified stable top anchor through $($prayer.motion_sample_count) animation frames; range=$motionSpan CSS px."
  $null = Capture-Top 'prayer-expanded'

  Click-RectCenter $prayer
  $collapsed = Wait-ForRow 'idle' 15 ([long]$prayer.timestamp_unix_ms)
  if ($collapsed.aligned_within_half_pixel -ne $true) { throw "Collapsed capsule is outside the 0.5px monitor-anchor tolerance: $($collapsed.capsule_center_error_from_anchor_px | ConvertTo-Json -Compress)" }
  Assert-Anchor $collapsed
  Assert-RenderGutter $collapsed
  Assert-ClickThroughOutsideCapsule $collapsed
  Assert-ClickThroughRoundedCorner $collapsed
  $collapsedShot = Capture-Top 'idle-after-collapse'
  Assert-BlackCapsuleCenter $collapsed $collapsedShot
  Copy-Item -Force $logPath (Join-Path $outDir 'geometry-final.jsonl')

  $summary = @(
    'PASS: launched the built Tarteel Windows executable.',
    "PASS: measured idle capsule offset before correction=$($idle.pre_alignment.capsule_center_error_from_anchor_px | ConvertTo-Json -Compress); after correction=$($collapsed.capsule_center_error_from_anchor_px | ConvertTo-Json -Compress).",
    'PASS: visible idle capsule remains 44x24 CSS px with a transparent render gutter on every side.',
    'PASS: music compact capsule remains 112x24 CSS px; rounded-corner and outside hit-testing pass through to the window behind.',
    "PASS: physical click expanded the full player to 384x210 CSS px with a measured lower gutter; top-anchor range=$fullMotionSpan CSS px across $($full.motion_sample_count) frames.",
    "PASS: physical click expanded prayer state without clipping its bottom edge; lower gutter verified; top-anchor range=$motionSpan CSS px across $($prayer.motion_sample_count) frames.",
    'PASS: physical mouse click returned to idle, the island remained centered, and native hit-testing passed through outside its rounded corner and edge.',
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
  if ($null -eq $previousWebViewArgs) { Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue }
  else { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousWebViewArgs }
  if (Test-Path $logPath) { Copy-Item -Force $logPath (Join-Path $outDir 'geometry-final.jsonl') }
}
