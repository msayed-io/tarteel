param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)

$ErrorActionPreference = 'Stop'
$outDir = Join-Path $env:GITHUB_WORKSPACE 'artifacts/island-ui-smoke'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$webViewDebugPort = $portProbe.LocalEndpoint.Port
$portProbe.Stop()
$webViewDebugArguments = "--remote-debugging-port=$webViewDebugPort"
$audioMeterResults = @()
$audioTestRoot = Join-Path $env:RUNNER_TEMP 'tarteel-audio-smoke'
$audioLibrary = Join-Path $audioTestRoot 'with-tracks'
$silenceLibrary = Join-Path $audioTestRoot 'with-silence'
$emptyAudioLibrary = Join-Path $audioTestRoot 'empty'
$webViewProfile = Join-Path $audioTestRoot 'webview2-profile'
$audioMeterScript = Join-Path $env:GITHUB_WORKSPACE 'test/windows-audio-meter.mjs'
$statusPath = Join-Path $outDir 'status.txt'
$logPath = Join-Path $env:APPDATA 'com.tarteel.desktop/island-geometry.jsonl'
$placementPath = Join-Path $env:APPDATA 'com.tarteel.desktop/island-position.json'
$process = $null
$previousSmokeFlag = $env:TARTEEL_WINDOWS_SMOKE_TEST
$previousAlertSmokeFlag = $env:TARTEEL_WINDOWS_ALERT_SMOKE_TEST
$previousSmokeCdpFlag = $env:TARTEEL_WINDOWS_SMOKE_CDP
$previousSmokeCdpPort = $env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT
$previousSmokeCdpDataDirectory = $env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR

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

function Click-IslandOffset($Record, [double]$OffsetX, [double]$OffsetY) {
  $rect = $Record.capsule_rect_screen
  if ($null -eq $rect) { throw "State '$($Record.state)' has no measured island rectangle" }
  $cx = ([double]$rect.left + [double]$rect.right) / 2.0
  $cy = ([double]$rect.top + [double]$rect.bottom) / 2.0
  $scale = 0.8 * [double]$Record.scale_factor
  $x = [int][Math]::Round($cx + $OffsetX * $scale)
  $y = [int][Math]::Round($cy + $OffsetY * $scale)
  if (-not [TarteelUiSmokeNative]::SetCursorPos($x, $y)) { throw "SetCursorPos failed at ($x,$y) for the measured island control." }
  Start-Sleep -Milliseconds 100
  [TarteelUiSmokeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 70
  [TarteelUiSmokeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host "Sent physical mouse click to measured island control at ($x,$y) from $($Record.state)."
}

function Swipe-IslandOffset($Record, [double]$OffsetXCss, [double]$OffsetYCss, [int]$DurationMs = 180) {
  $rect = $Record.capsule_rect_screen
  if ($null -eq $rect) { throw "State '$($Record.state)' has no measured island rectangle for a swipe" }
  $cx = ([double]$rect.left + [double]$rect.right) / 2.0
  $cy = ([double]$rect.top + [double]$rect.bottom) / 2.0
  $scale = [double]$Record.scale_factor
  $x0 = [int][Math]::Round($cx); $y0 = [int][Math]::Round($cy)
  $x1 = [int][Math]::Round($cx + $OffsetXCss * $scale)
  $y1 = [int][Math]::Round($cy + $OffsetYCss * $scale)
  if (-not [TarteelUiSmokeNative]::SetCursorPos($x0, $y0)) { throw "SetCursorPos failed at ($x0,$y0) before swipe." }
  Start-Sleep -Milliseconds 80
  [TarteelUiSmokeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  try {
    for ($step = 1; $step -le 8; $step++) {
      $x = [int][Math]::Round($x0 + ($x1 - $x0) * $step / 8.0)
      $y = [int][Math]::Round($y0 + ($y1 - $y0) * $step / 8.0)
      if (-not [TarteelUiSmokeNative]::SetCursorPos($x, $y)) { throw "SetCursorPos failed at ($x,$y) during swipe." }
      Start-Sleep -Milliseconds ([int][Math]::Max(8, $DurationMs / 8))
    }
  } finally {
    [TarteelUiSmokeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
  Write-Host "Sent physical pointer swipe from measured $($Record.state) capsule by ($OffsetXCss,$OffsetYCss) CSS px."
}

function Find-IslandElement($Record, [string]$Name) {
  $hwnd = [IntPtr]([long]$Record.window_handle)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $Name
  )
  $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  foreach ($element in $elements) {
    if (-not $element.Current.IsOffscreen) { return $element }
  }
  return $null
}

function Wait-IslandElement($Record, [string]$Name, [int]$TimeoutSeconds = 8, [switch]$Absent) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $element = Find-IslandElement $Record $Name
    $visible = $null -ne $element -and -not $element.Current.IsOffscreen
    if ($Absent -and -not $visible) { return $true }
    if (-not $Absent -and $visible) { return $element }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  if ($Absent) { throw "Accessible island element '$Name' remained visible." }
  throw "Accessible island element '$Name' was not found in time."
}

function Wait-MainLibrary([int]$TimeoutSeconds = 10) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'اختر مجلد الصوت لبدء مكتبتك'
  )
  do {
    $element = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      $condition
    )
    if ($null -ne $element -and -not $element.Current.IsOffscreen) {
      Write-Host 'Verified the existing main-window recitation library is visible.'
      return $element
    }
    if ($process -and $process.HasExited) { throw "Tarteel exited while opening the main-window library (code $($process.ExitCode))." }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw 'The empty-state library action did not bring the existing recitation library into view.'
}

function Find-MainButton([string]$Name) {
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $Name
  )
  $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )
  foreach ($element in $elements) {
    if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and -not $element.Current.IsOffscreen) { return $element }
  }
  return $null
}

function Wait-MainTrack([string]$FileName, [int]$TimeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  do {
    $buttons = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $condition
    )
    foreach ($button in $buttons) {
      $name = $button.Current.Name
      if (-not $button.Current.IsOffscreen -and -not [string]::IsNullOrEmpty($name) -and $name.Contains($FileName)) { return $button }
    }
    if ($process -and $process.HasExited) { throw "Tarteel exited while waiting for library track '$FileName'." }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "The main-window library did not expose track '$FileName'."
}

function Get-FolderDialog {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window
    )
  )
  foreach ($window in $windows) {
    if ($window.Current.Name -match 'اختر مجلد التلاوات|Select|Open|Choose|Browse|Folder|Directory|مجلد|التلاوات|اختيار|تحديد') { return $window }
  }
  return $null
}

function Select-MainAudioFolder([string]$FolderPath) {
  $button = Find-MainButton 'اختيار مجلد الصوت'
  if ($null -eq $button) { throw 'The visible main window did not expose its existing «اختيار مجلد الصوت» button.' }
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  $deadline = (Get-Date).AddSeconds(15)
  $dialog = $null
  do {
    $dialog = Get-FolderDialog
    if ($null -ne $dialog) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  if ($null -eq $dialog) {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
      )
    )
    $windowNames = @()
    foreach ($window in $windows) { $windowNames += "$($window.Current.Name) [$($window.Current.ClassName); PID $($window.Current.ProcessId)]" }
    throw "The native folder picker did not open for '$FolderPath'. Top-level UIA windows: $($windowNames -join '; ')"
  }
  $dialog.SetFocus()
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait($FolderPath)
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 350
  $dialog = Get-FolderDialog
  if ($null -ne $dialog) {
    $buttons = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      )
    )
    $select = $null
    foreach ($candidate in $buttons) {
      if ($candidate.Current.Name -match 'Select|Choose|Open|Folder|اختر|اختيار|تحديد|موافق') { $select = $candidate; break }
    }
    if ($null -eq $select) { throw "The native folder picker stayed open without a Select/Choose button after navigating to '$FolderPath'." }
    $select.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
  $deadline = (Get-Date).AddSeconds(8)
  do {
    if ($null -eq (Get-FolderDialog)) { Write-Host "Selected real library folder through the existing picker: $FolderPath"; return }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw "The native folder picker did not close after selecting '$FolderPath'."
}

function Invoke-MainTrack([string]$FileName) {
  $element = Wait-MainTrack $FileName
  $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 200
  Write-Host "Started the real library track through the existing application row: $FileName"
}

function Assert-WebViewAudio([string]$Mode, [string]$FileName = '') {
  $output = & node $audioMeterScript $webViewDebugPort $Mode $FileName 2>&1
  $exitCode = $LASTEXITCODE
  $text = $output -join [Environment]::NewLine
  if ($exitCode -ne 0) { throw "WebView2 audio assertion '$Mode' failed (node exit $exitCode): $text" }
  try { $measurement = ConvertFrom-Json -InputObject $text }
  catch { throw "WebView2 audio assertion '$Mode' returned invalid measurement JSON: $text" }
  $script:audioMeterResults += $measurement
  Write-Host $text
}

function Wait-WebViewDebugPort([int]$TimeoutSeconds = 30) {
  $endpoint = "http://127.0.0.1:$webViewDebugPort/json/version"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-RestMethod -Uri $endpoint -TimeoutSec 1
      if ($response.webSocketDebuggerUrl) {
        Write-Host "Verified WebView2 DevTools endpoint on port $webViewDebugPort ($($response.Browser))."
        return
      }
    } catch { }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  $webViewProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Select-Object ProcessId, CommandLine)
  $appProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='tarteel.exe'" -ErrorAction SilentlyContinue | Select-Object ProcessId, CommandLine)
  $details = @{ port = $webViewDebugPort; profile = $webViewProfile; browserArguments = $webViewDebugArguments; webViewProcesses = $webViewProcesses; appProcesses = $appProcesses } | ConvertTo-Json -Compress -Depth 5
  throw "WebView2 DevTools did not open at $endpoint within $TimeoutSeconds seconds. Process diagnostics: $details"
}

function Write-DigitalSilenceWav([string]$Path) {
  $sampleRate = 48000
  $dataBytes = $sampleRate * 4 * 2
  $stream = [System.IO.File]::Create($Path)
  $writer = $null
  try {
    $writer = [System.IO.BinaryWriter]::new($stream, [System.Text.Encoding]::ASCII)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
    $writer.Write([int]($dataBytes + 36))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
    $writer.Write([int]16)
    $writer.Write([short]1)
    $writer.Write([short]1)
    $writer.Write([int]$sampleRate)
    $writer.Write([int]($sampleRate * 2))
    $writer.Write([short]2)
    $writer.Write([short]16)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
    $writer.Write([int]$dataBytes)
    $writer.Write([byte[]]::new($dataBytes))
  } finally {
    if ($null -ne $writer) { $writer.Dispose() } else { $stream.Dispose() }
  }
}

function Click-IslandElement($Record, [string]$Name) {
  $element = Wait-IslandElement $Record $Name
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
  } catch {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $pattern.Toggle()
  }
  Start-Sleep -Milliseconds 250
  Write-Host "Invoked accessible island control '$Name'."
}

function Assert-IslandToggleState($Record, [string]$Name, [bool]$ExpectedOn, [int]$TimeoutSeconds = 8) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $element = Find-IslandElement $Record $Name
    if ($null -ne $element -and -not $element.Current.IsOffscreen) {
      try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $isOn = $pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
        if ($isOn -eq $ExpectedOn) {
          Write-Host "Verified '$Name' accessible toggle is $isOn."
          return
        }
      } catch { }
    }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "Accessible island toggle '$Name' did not reach expected state $ExpectedOn."
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
  Assert-PlacementAnchor $Record
  $rect = $Record.capsule_rect_screen
  $anchor = $Record.capsule_anchor_center_screen
  if ($null -eq $rect -or $null -eq $anchor) { throw 'Geometry record is missing a capsule or placement anchor.' }
  $cx = ([double]$rect.left + [double]$rect.right) / 2.0
  $cy = ([double]$rect.top + [double]$rect.bottom) / 2.0
  $dx = $cx - [double]$anchor.x
  $dy = $cy - [double]$anchor.y
  if ([Math]::Abs($dx) -gt 0.5 -or [Math]::Abs($dy) -gt 0.5) {
    throw "Capsule center is outside the 0.5 physical-pixel monitor-anchor tolerance: dx=$dx, dy=$dy."
  }
  Write-Host "Verified collapsed capsule center against the saved placement anchor ($($anchor.x),$($anchor.y)): dx=$dx, dy=$dy."
}

function Assert-PlacementAnchor($Record) {
  $anchor = $Record.capsule_anchor_center_screen
  $monitor = $Record.monitor_rc_monitor
  if ($null -eq $anchor -or $null -eq $monitor) { throw 'Geometry record is missing a placement anchor or monitor rectangle.' }
  if ($Record.placement_mode -ne 'manual') { throw "Expected the persisted manual mode, got '$($Record.placement_mode)' in '$($Record.state)'." }
  if ([double]$Record.placement_offset_y_px -ge 0) { throw "Expected the persisted manual anchor to cross the former top limit, got Y offset $($Record.placement_offset_y_px) px." }
  $expectedX = ([double]$monitor.left + [double]$monitor.right) / 2.0 + [double]$Record.placement_offset_x_px
  $expectedY = [double]$monitor.top + 19.0 * [double]$Record.scale_factor + [double]$Record.placement_offset_y_px
  if ([Math]::Abs([double]$anchor.x - $expectedX) -gt 0.01 -or [Math]::Abs([double]$anchor.y - $expectedY) -gt 0.01) {
    throw "The measured anchor disagrees with the saved manual offset. Expected ($expectedX,$expectedY), measured ($($anchor.x),$($anchor.y))."
  }
  Write-Host "Verified $($Record.state) placement anchor at ($($anchor.x),$($anchor.y)) from saved physical offsets ($($Record.placement_offset_x_px),$($Record.placement_offset_y_px))."
}

function Assert-SamePlacementAnchor($First, $Next) {
  Assert-PlacementAnchor $Next
  $dx = [double]$Next.capsule_anchor_center_screen.x - [double]$First.capsule_anchor_center_screen.x
  $dy = [double]$Next.capsule_anchor_center_screen.y - [double]$First.capsule_anchor_center_screen.y
  if ([Math]::Abs($dx) -gt 0.5 -or [Math]::Abs($dy) -gt 0.5) {
    throw "The placement anchor changed between '$($First.state)' and '$($Next.state)': dx=$dx, dy=$dy."
  }
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
  $minimumGutter = 2.0 * $scale
  if ($left -lt $minimumGutter -or $top -lt $minimumGutter -or $rightGap -lt $minimumGutter -or $bottomGap -lt $minimumGutter) {
    throw "The visible capsule has less than a 2 CSS-pixel render gutter: left=$left, top=$top, right=$rightGap, bottom=$bottomGap."
  }
  Write-Host "Verified 44x24 CSS-pixel visible capsule with a >=2 CSS-pixel transparent render gutter; margins=($left,$top,$rightGap,$bottomGap)."
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
  if ($bottomGap -lt 2.0) { throw "Expanded '$($Record.state)' surface has only $bottomGap CSS px of lower viewport gutter; at least 2 CSS px are required." }
  $screen = $Record.capsule_rect_screen
  $monitor = $Record.monitor_rc_monitor
  if ($null -eq $screen -or $null -eq $monitor -or [double]$screen.left -lt [double]$monitor.left -or [double]$screen.top -lt [double]$monitor.top -or [double]$screen.right -gt [double]$monitor.right -or [double]$screen.bottom -gt [double]$monitor.bottom) {
    throw "Expanded '$($Record.state)' surface leaves the selected monitor: screen=$($screen | ConvertTo-Json -Compress), monitor=$($monitor | ConvertTo-Json -Compress)."
  }
  Write-Host "Verified expanded '$($Record.state)' bounds stay inside the WebView client with $bottomGap CSS px of lower viewport gutter."
}

function Assert-MusicCompactBounds($Record) {
  $rect = $Record.capsule_rect_client
  $size = $Record.client_size
  $scale = [double]$Record.scale_factor
  if ($null -eq $rect -or $null -eq $size -or $scale -le 0) { throw 'Music compact geometry is missing a capsule rectangle, client size, or valid scale factor.' }
  $width = ([double]$rect.right - [double]$rect.left) / $scale
  $height = ([double]$rect.bottom - [double]$rect.top) / $scale
  if ([Math]::Abs($width - 112.0) -gt 0.75 -or [Math]::Abs($height - 24.0) -gt 0.75) {
    throw "The visible music compact capsule changed size: $width x $height CSS px; expected 112 x 24."
  }
  $minimumGutter = 2.0 * $scale
  $leftGap = [double]$rect.left
  $topGap = [double]$rect.top
  $rightGap = [double]$size.width - [double]$rect.right
  $bottomGap = [double]$size.height - [double]$rect.bottom
  if ($leftGap -lt $minimumGutter -or $topGap -lt $minimumGutter -or $rightGap -lt $minimumGutter -or $bottomGap -lt $minimumGutter) {
    throw "The music capsule has less than a 2 CSS-pixel render gutter: left=$leftGap, top=$topGap, right=$rightGap, bottom=$bottomGap."
  }
  Write-Host "Verified visible music compact rounded rectangle remains 112x24 CSS px."
}

function Get-PixelLuma($Color) {
  return (0.2126 * [double]$Color.R + 0.7152 * [double]$Color.G + 0.0722 * [double]$Color.B)
}

function Assert-MusicRoundedCorners($Record, [string]$ScreenshotPath) {
  $rect = $Record.capsule_rect_screen
  $scale = [double]$Record.scale_factor
  if ($null -eq $rect -or $scale -le 0) { throw 'Music pixel check is missing screen bounds or a valid DPI scale.' }
  $left = [int][Math]::Round([double]$rect.left)
  $top = [int][Math]::Round([double]$rect.top)
  $right = [int][Math]::Round([double]$rect.right)
  $bottom = [int][Math]::Round([double]$rect.bottom)
  $radius = [int][Math]::Round(11.0 * $scale)
  $bitmap = [System.Drawing.Bitmap]::FromFile($ScreenshotPath)
  try {
    if ($left -lt 3 -or $top -lt 2 -or $right + 2 -ge $bitmap.Width -or $bottom + 2 -ge $bitmap.Height) {
      throw "Music capsule ($left,$top)-($right,$bottom) is outside screenshot $($bitmap.Width)x$($bitmap.Height)."
    }
    $midY = [int][Math]::Round(($top + $bottom) / 2.0)
    $inset = [int][Math]::Round(4.0 * $scale)
    $insideLeftColor = $bitmap.GetPixel($left + $inset, $midY)
    $insideRightColor = $bitmap.GetPixel($right - $inset - 1, $midY)
    $insideLeft = Get-PixelLuma $insideLeftColor
    $insideRight = Get-PixelLuma $insideRightColor
    if ($insideLeft -gt 80 -or $insideRight -gt 80) {
      throw "Music surface interior is not dark at both edges: left=$insideLeft, right=$insideRight."
    }

    $corners = @(
      [pscustomobject]@{ Name = 'top-left'; X = $left; Y = $top; SX = 1; SY = 1 },
      [pscustomobject]@{ Name = 'top-right'; X = $right - 1; Y = $top; SX = -1; SY = 1 },
      [pscustomobject]@{ Name = 'bottom-left'; X = $left; Y = $bottom - 1; SX = 1; SY = -1 },
      [pscustomobject]@{ Name = 'bottom-right'; X = $right - 1; Y = $bottom - 1; SX = -1; SY = -1 }
    )
    foreach ($corner in $corners) {
      $cornerColor = $bitmap.GetPixel($corner.X + $corner.SX, $corner.Y + $corner.SY)
      $backgroundColor = $bitmap.GetPixel($corner.X - 3 * $corner.SX, $corner.Y + $corner.SY)
      $cornerLuma = Get-PixelLuma $cornerColor
      $backgroundLuma = Get-PixelLuma $backgroundColor
      if ($backgroundLuma -lt 140) { throw "The Windows title-bar backdrop behind the $($corner.Name) corner is not high-contrast enough to validate the rendered curve (luma=$backgroundLuma)." }
      if ([Math]::Abs($cornerLuma - $backgroundLuma) -gt 25) {
        throw "The $($corner.Name) pixel is dark instead of following the background outside the rounded rectangle: corner=$cornerLuma, background=$backgroundLuma."
      }

      $antialiasedPixels = 0
      for ($depth = 0; $depth -le 2; $depth++) {
        for ($offset = 1; $offset -le $radius + 2; $offset++) {
          $sampleX = $corner.X + $corner.SX * $offset
          $sampleY = $corner.Y + $corner.SY * $depth
          $sampleColor = $bitmap.GetPixel($sampleX, $sampleY)
          $sampleLuma = Get-PixelLuma $sampleColor
          if ($sampleLuma -gt 3 -and $sampleLuma -lt ($backgroundLuma - 3)) { $antialiasedPixels++ }
        }
      }
      if ($antialiasedPixels -lt 1) { throw "No partially blended edge pixel was found along the $($corner.Name) curve; the edge may be hard-clipped." }
      Write-Host "Verified $($corner.Name) rendered corner: outside luma=$backgroundLuma, corner luma=$cornerLuma, antialiased edge pixels=$antialiasedPixels."
    }
    Write-Host "Verified music rounded-rectangle pixels at radius $radius physical px; both interior edge probes remain dark."
  } finally {
    $bitmap.Dispose()
  }
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
  $offset = [int][Math]::Round(1.0 * [double]$Record.scale_factor)
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
Add-Type -AssemblyName System.Windows.Forms
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
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

try {
  if (-not (Test-Path $ExePath)) { throw "Tarteel executable not found: $ExePath" }
  $fixturePath = Join-Path $env:GITHUB_WORKSPACE 'test/fixtures/Al-Fatiha-CC0.ogg'
  if (-not (Test-Path $fixturePath)) { throw "Test-only CC0 audio fixture is missing: $fixturePath" }
  $fixtureHash = (Get-FileHash -Path $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($fixtureHash -ne '59a4eef339d3e42aeaf9b77a6423297a0f830e4872783fc0718a64862b02df32') { throw "The test-only recitation fixture hash changed unexpectedly: $fixtureHash" }
  if (Test-Path $audioTestRoot) { Remove-Item -Recurse -Force $audioTestRoot }
  New-Item -ItemType Directory -Force -Path $audioLibrary, $silenceLibrary, $emptyAudioLibrary, $webViewProfile | Out-Null
  Copy-Item -Force $fixturePath (Join-Path $audioLibrary 'Al-Fatiha-01.ogg')
  Copy-Item -Force $fixturePath (Join-Path $audioLibrary 'Al-Fatiha-02.ogg')
  Write-DigitalSilenceWav (Join-Path $silenceLibrary 'Digital-Silence-Test.wav')
  if ([TarteelUiSmokeNative]::GetSystemMetrics(0) -le 0 -or [TarteelUiSmokeNative]::GetSystemMetrics(1) -le 0) {
    throw 'Windows runner exposes no interactive display; refusing to mark native geometry verification as passed.'
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $placementPath) | Out-Null
  # Keep a non-centered manual anchor while the capsule remains in the bright title-bar band used by the rim-corner probes.
  $placementJson = @{ mode = 'manual'; offsetX = 28; offsetY = -2 } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($placementPath, $placementJson, [System.Text.UTF8Encoding]::new($false))
  if (Test-Path $logPath) { Remove-Item -Force $logPath }
  $env:TARTEEL_WINDOWS_SMOKE_TEST = '1'
  $env:TARTEEL_WINDOWS_SMOKE_CDP = '1'
  $env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT = "$webViewDebugPort"
  $env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR = $webViewProfile
  $process = Start-Process -FilePath (Resolve-Path $ExePath) -WorkingDirectory (Split-Path (Resolve-Path $ExePath)) -PassThru
  Wait-WebViewDebugPort 30
  $idle = Wait-ForRow 'idle' 35
  if ($idle.aligned_within_half_pixel -ne $true) { throw "Idle alignment was not verified: $($idle.aligned_within_half_pixel)" }
  if ($null -eq $idle.capsule_rect_screen -or $null -eq $idle.capsule_anchor_center_screen) { throw 'Idle row did not include measured capsule and monitor-origin anchor coordinates.' }
  if ($null -eq $idle.pre_alignment -or $null -eq $idle.pre_alignment.capsule_center_error_from_anchor_px) { throw 'The idle row did not preserve the measured capsule offset before correction.' }
  Assert-Anchor $idle
  Assert-RenderGutter $idle
  $idleShot = Capture-Top 'idle-before-click'
  Assert-BlackCapsuleCenter $idle $idleShot
  Copy-Item -Force $logPath (Join-Path $outDir 'geometry-after-idle.jsonl')

  $music = Wait-ForRow 'compact' 25 ([long]$idle.timestamp_unix_ms)
  Assert-SamePlacementAnchor $idle $music
  Assert-MusicCompactBounds $music
  Assert-Anchor $music
  $musicShot = Capture-Top 'music-compact-before-full'
  Assert-MusicRoundedCorners $music $musicShot
  Swipe-IslandOffset $music 0 62
  $full = Wait-ForRow 'full' 15 ([long]$music.timestamp_unix_ms) -Expanded
  Assert-SamePlacementAnchor $idle $full
  Assert-FullStateBounds $full
  if ($full.aligned_within_half_pixel -ne $true) { throw "Full player window origin did not align to the monitor origin: $($full.aligned_within_half_pixel)" }
  if ($null -eq $full.motion_top_min_screen_css_px -or $null -eq $full.motion_top_max_screen_css_px -or [int]$full.motion_sample_count -lt 4) { throw 'Full player state did not include enough measured animation frames.' }
  $fullMotionSpan = [Math]::Abs([double]$full.motion_top_max_screen_css_px - [double]$full.motion_top_min_screen_css_px)
  if ($fullMotionSpan -gt 0.75) { throw "The full player top edge moved $fullMotionSpan CSS px during expansion; expected a fixed capsule anchor." }
  Write-Host "Verified full player bottom gutter and stable top anchor across $($full.motion_sample_count) animation frames; range=$fullMotionSpan CSS px."
  $null = Capture-Top 'full-expanded'
  Copy-Item -Force $logPath (Join-Path $outDir 'geometry-full.jsonl')

  # WebView2's UI Automation tree may omit this icon-only aria-labeled button;
  # click its measured physical position as a user would, then verify the state.
  Click-IslandOffset $full 192 81
  $tools = Wait-ForRow 'tools' 15 ([long]$full.timestamp_unix_ms) -Expanded
  Assert-SamePlacementAnchor $idle $tools
  Assert-ExpandedBoundsContained $tools
  $null = Capture-Top 'tools-expanded'
  foreach ($speed in @('0.75×', '1.25×', '1.5×', '1×')) {
    Click-IslandElement $tools $speed
    Assert-IslandToggleState $tools $speed $true
  }
  foreach ($sleep in @('15 د', '30 د', '60 د', 'نهاية السورة', 'إيقاف')) {
    Click-IslandElement $tools $sleep
    Assert-IslandToggleState $tools $sleep $true
  }
  Click-IslandElement $tools 'عرض الصلاة القادمة'
  Assert-IslandToggleState $tools 'عرض الصلاة القادمة' $true
  Click-IslandElement $tools 'عرض الصلاة القادمة'
  Assert-IslandToggleState $tools 'عرض الصلاة القادمة' $false
  Click-IslandElement $tools 'إيقاف التلاوة عند الأذان'
  Assert-IslandToggleState $tools 'إيقاف التلاوة عند الأذان' $false
  Click-IslandElement $tools 'إيقاف التلاوة عند الأذان'
  Assert-IslandToggleState $tools 'إيقاف التلاوة عند الأذان' $true
  Copy-Item -Force $logPath (Join-Path $outDir 'geometry-tools.jsonl')
  Click-IslandElement $tools 'رجوع'
  $fullAfterTools = Wait-ForRow 'full' 15 ([long]$tools.timestamp_unix_ms) -Expanded
  Assert-SamePlacementAnchor $idle $fullAfterTools
  Assert-FullStateBounds $fullAfterTools
  $null = Capture-Top 'full-after-tools'

  Click-RectCenter $fullAfterTools
  $musicCollapsed = Wait-ForRow 'compact' 15 ([long]$fullAfterTools.timestamp_unix_ms)
  Assert-MusicCompactBounds $musicCollapsed
  Assert-ClickThroughOutsideCapsule $musicCollapsed
  Assert-ClickThroughRoundedCorner $musicCollapsed
  $musicCollapsedShot = Capture-Top 'music-compact-after-full'
  Assert-MusicRoundedCorners $musicCollapsed $musicCollapsedShot

  Click-RectCenter $musicCollapsed
  $emptyFull = Wait-ForRow 'full' 15 ([long]$musicCollapsed.timestamp_unix_ms) -Expanded
  $null = Wait-IslandElement $emptyFull 'لا توجد تلاوة' 60
  $null = Capture-Top 'music-empty-full'
  Click-IslandElement $emptyFull 'تشغيل'
  $null = Wait-IslandElement $emptyFull 'لا توجد تلاوة' 4
  Click-IslandElement $emptyFull 'اختيار تلاوة'
  $null = Wait-MainLibrary 12
  Assert-WebViewAudio 'no-track'
  Assert-WebViewAudio 'cancel'
  Select-MainAudioFolder $audioLibrary
  Invoke-MainTrack 'Al-Fatiha-01.ogg'
  Assert-WebViewAudio 'playing' 'Al-Fatiha-01.ogg'
  Click-IslandElement $emptyFull 'إيقاف مؤقت'
  Assert-WebViewAudio 'paused'
  Click-IslandElement $emptyFull 'تشغيل'
  Assert-WebViewAudio 'playing' 'Al-Fatiha-01.ogg'
  Invoke-MainTrack 'Al-Fatiha-02.ogg'
  Assert-WebViewAudio 'playing' 'Al-Fatiha-02.ogg'
  Select-MainAudioFolder $silenceLibrary
  Invoke-MainTrack 'Digital-Silence-Test.wav'
  Assert-WebViewAudio 'silence' 'Digital-Silence-Test.wav'
  Select-MainAudioFolder $emptyAudioLibrary
  $null = Wait-MainLibrary 12
  Assert-WebViewAudio 'no-track'
  $null = Wait-IslandElement $emptyFull 'لا توجد تلاوة' 8
  Swipe-IslandOffset $emptyFull 0 -62
  $compactEmpty = Wait-ForRow 'compact' 15 ([long]$emptyFull.timestamp_unix_ms)
  Swipe-IslandOffset $compactEmpty 0 -62
  $idleBeforeEmptySwipe = Wait-ForRow 'idle' 15 ([long]$compactEmpty.timestamp_unix_ms)
  Swipe-IslandOffset $idleBeforeEmptySwipe 62 0
  $musicWithoutTrack = Wait-ForRow 'compact' 15 ([long]$idleBeforeEmptySwipe.timestamp_unix_ms)
  $null = Capture-Top 'music-empty-compact'
  Swipe-IslandOffset $musicWithoutTrack 0 62
  $expandedEmpty = Wait-ForRow 'full' 15 ([long]$musicWithoutTrack.timestamp_unix_ms) -Expanded
  $null = Wait-IslandElement $expandedEmpty 'لا توجد تلاوة' 8
  Swipe-IslandOffset $expandedEmpty 0 -62
  $compactAfterEmpty = Wait-ForRow 'compact' 15 ([long]$expandedEmpty.timestamp_unix_ms)
  Swipe-IslandOffset $compactAfterEmpty 0 -62
  $idleAfterMusic = Wait-ForRow 'idle' 15 ([long]$compactAfterEmpty.timestamp_unix_ms)
  Assert-Anchor $idleAfterMusic
  Assert-RenderGutter $idleAfterMusic

  Swipe-IslandOffset $idleAfterMusic 62 0
  $compactFromIdleSwipe = Wait-ForRow 'compact' 15 ([long]$idleAfterMusic.timestamp_unix_ms)
  Swipe-IslandOffset $compactFromIdleSwipe -62 0
  $prayerFromSwipe = Wait-ForRow 'prayer' 15 ([long]$compactFromIdleSwipe.timestamp_unix_ms) -Expanded
  Assert-SamePlacementAnchor $idle $prayerFromSwipe
  Assert-ExpandedBoundsContained $prayerFromSwipe
  Swipe-IslandOffset $prayerFromSwipe 62 0
  $compactFromPrayerSwipe = Wait-ForRow 'compact' 15 ([long]$prayerFromSwipe.timestamp_unix_ms)
  Swipe-IslandOffset $compactFromPrayerSwipe 62 0
  $idleAfterDirections = Wait-ForRow 'idle' 15 ([long]$compactFromPrayerSwipe.timestamp_unix_ms)
  Assert-Anchor $idleAfterDirections
  Assert-RenderGutter $idleAfterDirections

  Click-RectCenter $idleAfterDirections
  $prayer = Wait-ForRow 'prayer' 15 ([long]$idleAfterDirections.timestamp_unix_ms) -Expanded
  Assert-SamePlacementAnchor $idle $prayer
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

  $savedAnchor = $collapsed.capsule_anchor_center_screen
  if ($null -eq $previousSmokeCdpPort) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT = $previousSmokeCdpPort }
  if ($null -eq $previousSmokeCdpDataDirectory) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR = $previousSmokeCdpDataDirectory }
  if ($null -eq $previousSmokeCdpFlag) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_CDP -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_SMOKE_CDP = $previousSmokeCdpFlag }
  if ($null -eq $previousSmokeFlag) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_TEST -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_SMOKE_TEST = $previousSmokeFlag }
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  if ($process) { $process.WaitForExit() }
  Remove-Item -Force $logPath -ErrorAction SilentlyContinue
  $previousSmokeFlag = $env:TARTEEL_WINDOWS_SMOKE_TEST
  $env:TARTEEL_WINDOWS_SMOKE_TEST = '1'
  $env:TARTEEL_WINDOWS_ALERT_SMOKE_TEST = '1'
  try {
    $process = Start-Process -FilePath (Resolve-Path $ExePath) -WorkingDirectory (Split-Path (Resolve-Path $ExePath)) -PassThru
  } finally {
    if ($null -eq $previousSmokeFlag) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_TEST -ErrorAction SilentlyContinue }
    else { $env:TARTEEL_WINDOWS_SMOKE_TEST = $previousSmokeFlag }
    if ($null -eq $previousAlertSmokeFlag) { Remove-Item Env:TARTEEL_WINDOWS_ALERT_SMOKE_TEST -ErrorAction SilentlyContinue }
    else { $env:TARTEEL_WINDOWS_ALERT_SMOKE_TEST = $previousAlertSmokeFlag }
  }
  $restored = Wait-ForRow 'idle' 35
  Assert-Anchor $restored
  $restoreDx = [double]$restored.capsule_anchor_center_screen.x - [double]$savedAnchor.x
  $restoreDy = [double]$restored.capsule_anchor_center_screen.y - [double]$savedAnchor.y
  if ([Math]::Abs($restoreDx) -gt 0.5 -or [Math]::Abs($restoreDy) -gt 0.5) { throw "The manual anchor did not survive a process restart: dx=$restoreDx, dy=$restoreDy." }
  Write-Host "Verified saved manual placement after relaunch: anchor delta=($restoreDx,$restoreDy)."
  $autoAlert = Wait-ForRow 'alert' 25 ([long]$restored.timestamp_unix_ms) -Expanded
  Assert-ExpandedBoundsContained $autoAlert
  $null = Capture-Top 'alert-before-auto-dismiss'
  $null = Wait-IslandElement $autoAlert 'تم'
  $null = Wait-IslandElement $autoAlert 'استئناف'
  $null = Wait-IslandElement $autoAlert 'إيقاف الأذان' 8 -Absent
  $null = Wait-IslandElement $autoAlert 'تم' 18 -Absent

  $manualAlert = Wait-ForRow 'alert' 20 ([long]$autoAlert.timestamp_unix_ms) -Expanded
  Assert-ExpandedBoundsContained $manualAlert
  $null = Wait-IslandElement $manualAlert 'تم'
  $null = Wait-IslandElement $manualAlert 'استئناف'
  Click-IslandElement $manualAlert 'استئناف'
  Click-IslandElement $manualAlert 'تم'
  $null = Wait-IslandElement $manualAlert 'تم' 8 -Absent
  Write-Host 'Verified the automatic completion hides the alert; the single «تم» action closes the next alert. Resume was sent without an active test recitation.'

  $audioMeterSummary = @($audioMeterResults | ForEach-Object {
    $cpu = if ($null -eq $_.rendererTaskCpuPercentApprox) { 'unavailable' } else { '{0:N2}%' -f [double]$_.rendererTaskCpuPercentApprox }
    "$($_.mode)=$cpu renderer-task CPU; runtime errors=$($_.runtimeErrors); console errors=$($_.consoleErrors)"
  })
  $summary = @(
    'PASS: launched the built Tarteel Windows executable.',
    "PASS: measured idle capsule offset before correction=$($idle.pre_alignment.capsule_center_error_from_anchor_px | ConvertTo-Json -Compress); after correction=$($collapsed.capsule_center_error_from_anchor_px | ConvertTo-Json -Compress).",
    'PASS: visible idle capsule remains 44x24 CSS px with a transparent render gutter on every side.',
    'PASS: music compact rounded rectangle remains 112x24 CSS px with radius 11; all four screenshot corners and antialiased edge pixels pass, and outside hit-testing reaches the window behind.',
    "PASS: physical downward swipe expanded the full player to 384x210 CSS px with a measured lower gutter; top-anchor range=$fullMotionSpan CSS px across $($full.motion_sample_count) frames.",
    'PASS: tools expanded at the same anchor; every speed, sleep duration/mode, and both prayer preferences changed and restored through the main-window event bridge.',
    "PASS: physical click expanded prayer state without clipping its bottom edge; lower gutter verified; top-anchor range=$motionSpan CSS px across $($prayer.motion_sample_count) frames.",
    'PASS: synthetic adhan alert expanded within bounds and auto-dismissed on its completion event; the only «تم» button closed a second alert. No audio was played; actual device audio and recitation resume are not covered.',
    'PASS: physical mouse taps and directional swipes preserved click behavior, reached music from idle with no recitation, returned to idle, and retained the same manual anchor; native hit-testing passed through outside its rounded corner and edge.',
    'PASS: no-track music stayed empty; the existing library loaded a test-only CC0 recitation and a temporary digital-silence WAV in the built Windows app; measured live audio waves, settled silent bars, pause/resume, track switching, and removal back to empty. Test audio stayed in RUNNER_TEMP and was not bundled.',
    "WebView performance/error samples: $($audioMeterSummary -join '; ').",
    'PASS: a negative Manual Y offset crossed the former top limit across idle, music, prayer, and full states, then restored after process relaunch.',
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
  if ($null -eq $previousSmokeFlag) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_TEST -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_SMOKE_TEST = $previousSmokeFlag }
  if ($null -eq $previousAlertSmokeFlag) { Remove-Item Env:TARTEEL_WINDOWS_ALERT_SMOKE_TEST -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_ALERT_SMOKE_TEST = $previousAlertSmokeFlag }
  if ($null -eq $previousSmokeCdpFlag) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_CDP -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_SMOKE_CDP = $previousSmokeCdpFlag }
  if ($null -eq $previousSmokeCdpPort) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT = $previousSmokeCdpPort }
  if ($null -eq $previousSmokeCdpDataDirectory) { Remove-Item Env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR = $previousSmokeCdpDataDirectory }
  if (Test-Path $audioTestRoot) { Remove-Item -Recurse -Force $audioTestRoot -ErrorAction SilentlyContinue }
  if (Test-Path $logPath) { Copy-Item -Force $logPath (Join-Path $outDir 'geometry-final.jsonl') }
}
