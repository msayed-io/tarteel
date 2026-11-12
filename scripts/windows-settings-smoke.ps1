param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)

$ErrorActionPreference = 'Stop'
$resolvedExe = (Resolve-Path $ExePath).Path
if (-not (Test-Path $resolvedExe -PathType Leaf)) { throw "Windows app executable not found: $resolvedExe" }
if ([string]::IsNullOrWhiteSpace($env:APPDATA)) { throw 'APPDATA is unavailable; refusing to move application data.' }
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable; refusing to move application data.' }

$workspace = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { (Get-Location).Path }
$nodeScript = Join-Path $workspace 'test/windows-settings-smoke.mjs'
if (-not (Test-Path $nodeScript -PathType Leaf)) { throw "Settings smoke script not found: $nodeScript" }
$outDir = Join-Path $workspace 'artifacts/settings-ui-smoke'
$tempRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { [System.IO.Path]::GetTempPath() } else { $env:RUNNER_TEMP }
$testRoot = Join-Path $tempRoot ("tarteel-settings-smoke-" + [Guid]::NewGuid().ToString('N'))
$sessionDir = Join-Path $testRoot 'session'
$islandWebViewProfile = Join-Path $testRoot 'island-webview2-profile'
$backupDir = Join-Path $testRoot 'saved-runner-data'
$roamingAppData = Join-Path $env:APPDATA 'com.tarteel.desktop'
$localAppData = Join-Path $env:LOCALAPPDATA 'com.tarteel.desktop'
$roamingBackup = Join-Path $backupDir 'roaming-app-data'
$localBackup = Join-Path $backupDir 'local-app-data'
$roamingOriginallyExisted = Test-Path $roamingAppData
$localOriginallyExisted = Test-Path $localAppData
$runKeyPath = 'Software\Microsoft\Windows\CurrentVersion\Run'
$runKeyExisted = $false
$runKeySnapshot = @{}
$script:initialTarteelTaskNames = @()
$script:testCreatedTarteelTaskNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$process = $null
$mainPort = 0
$islandPort = 0
$previousWebViewArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$previousSmokeCdpFlag = $env:TARTEEL_WINDOWS_SMOKE_CDP
$previousSmokeCdpPort = $env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT
$previousSmokeCdpDataDirectory = $env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR
$previousSettingsIslandPort = $env:TARTEEL_SETTINGS_ISLAND_PORT
$previousSettingsArtifactDir = $env:TARTEEL_SETTINGS_ARTIFACT_DIR
$previousSettingsSessionDir = $env:TARTEEL_SETTINGS_SESSION_DIR

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return [int]$listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Get-TarteelScheduledTaskNames {
  $output = @(& schtasks.exe /Query /FO CSV /NH 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "schtasks.exe failed to enumerate tasks (exit code $LASTEXITCODE)." }
  $names = @()
  foreach ($entry in @($output | ConvertFrom-Csv -Header TaskName,NextRunTime,Status,LogonMode -ErrorAction Stop)) {
    $qualifiedName = ([string]$entry.TaskName).Trim().TrimStart('\')
    if (-not $qualifiedName) { continue }
    $name = ($qualifiedName -split '\\')[-1]
    if ($name.StartsWith('TarteelAdhan_', [System.StringComparison]::OrdinalIgnoreCase)) { $names += $name }
  }
  return @($names | Sort-Object -Unique)
}

function Record-TestCreatedTarteelTasks {
  foreach ($taskName in @(Get-TarteelScheduledTaskNames)) {
    if ($script:initialTarteelTaskNames -notcontains $taskName) { $null = $script:testCreatedTarteelTaskNames.Add($taskName) }
  }
}

function Remove-TestCreatedTarteelTasks {
  Record-TestCreatedTarteelTasks
  $remaining = @(Get-TarteelScheduledTaskNames)
  $taskCleanupFailures = [System.Collections.Generic.List[string]]::new()
  foreach ($taskName in $script:testCreatedTarteelTaskNames) {
    if ($remaining -notcontains $taskName) { continue }
    try {
      $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
      if (-not $task) { $taskCleanupFailures.Add("Task '$taskName' was listed by schtasks but not found in the root task path."); continue }
      $actions = @($task.Actions)
      $owned = $actions.Count -gt 0
      foreach ($action in $actions) {
        $actionPath = [string]$action.Execute
        if (-not $actionPath) { $owned = $false; break }
        try { $actionPath = [System.IO.Path]::GetFullPath($actionPath.Trim('"')) } catch { $owned = $false; break }
        if (-not [string]::Equals($actionPath, $resolvedExe, [System.StringComparison]::OrdinalIgnoreCase)) { $owned = $false; break }
      }
      if (-not $owned) { $taskCleanupFailures.Add("Refused to remove '$taskName': every task action must target this test executable."); continue }
      $null = Unregister-ScheduledTask -TaskPath '\' -TaskName $taskName -Confirm:$false
      Write-Host "Removed test-created Tarteel task $taskName."
    } catch {
      $taskCleanupFailures.Add("Could not remove '$taskName': $($_.Exception.Message)")
    }
  }
  $untracked = @(Get-TarteelScheduledTaskNames | Where-Object { $script:initialTarteelTaskNames -notcontains $_ -and -not $script:testCreatedTarteelTaskNames.Contains($_) })
  if ($untracked.Count -gt 0) { $taskCleanupFailures.Add("Untracked Tarteel tasks appeared during the run and were left untouched: $($untracked -join ', ')") }
  $leftovers = @(Get-TarteelScheduledTaskNames | Where-Object { $script:testCreatedTarteelTaskNames.Contains($_) })
  if ($leftovers.Count -gt 0) { $taskCleanupFailures.Add("Test-created tasks remain after cleanup: $($leftovers -join ', ')") }
  if ($taskCleanupFailures.Count -gt 0) { throw ($taskCleanupFailures -join '; ') }
}

function Wait-WebViewTarget([int]$Port, [System.Diagnostics.Process]$Child, [string]$Label) {
  $uri = "http://127.0.0.1:$Port/json/list"
  $deadline = (Get-Date).AddSeconds(40)
  do {
    if ($Child -and $Child.HasExited) { throw "Tarteel exited with code $($Child.ExitCode) while waiting for $Label WebView2 CDP." }
    try {
      $targets = @(Invoke-RestMethod -Uri $uri -TimeoutSec 2)
      if ($targets.Count -gt 0) { Write-Host "$Label WebView2 CDP ready on port $Port."; return }
    } catch { }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $Label WebView2 CDP at $uri."
}

function Start-TarteelForSmoke {
  $script:mainPort = Get-FreeLoopbackPort
  $script:islandPort = Get-FreeLoopbackPort
  while ($script:islandPort -eq $script:mainPort) { $script:islandPort = Get-FreeLoopbackPort }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$script:mainPort"
  $env:TARTEEL_WINDOWS_SMOKE_CDP = '1'
  $env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT = "$script:islandPort"
  $env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR = $islandWebViewProfile
  $env:TARTEEL_SETTINGS_ISLAND_PORT = "$script:islandPort"
  $script:process = Start-Process -FilePath $resolvedExe -WorkingDirectory (Split-Path $resolvedExe) -PassThru
  Write-Host "Started isolated Tarteel process $($script:process.Id); main CDP=$script:mainPort, island CDP=$script:islandPort."
  Wait-WebViewTarget $script:mainPort $script:process 'main settings'
  Wait-WebViewTarget $script:islandPort $script:process 'Dynamic Island'
}

function Stop-TarteelForSmoke {
  if ($script:process) {
    $script:process.Refresh()
  }
  if ($script:process -and -not $script:process.HasExited) {
    try { $null = $script:process.CloseMainWindow() } catch { }
    if (-not $script:process.WaitForExit(2500)) {
      Stop-Process -Id $script:process.Id -Force -ErrorAction SilentlyContinue
      if (-not $script:process.WaitForExit(15000)) { throw 'Tarteel process did not stop after the settings smoke test.' }
    }
  }
  $script:process = $null
  Start-Sleep -Milliseconds 700
  $ownedProfiles = @($localAppData, $islandWebViewProfile)
  foreach ($webView in @(Get-CimInstance -ClassName Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue)) {
    if (-not $webView.CommandLine) { continue }
    $owned = $false
    foreach ($profile in $ownedProfiles) {
      if ($webView.CommandLine.IndexOf($profile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $owned = $true; break }
    }
    if ($owned) { Stop-Process -Id $webView.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Milliseconds 500
}

function Invoke-NodePhase([string]$Phase) {
  Write-Host "Running actual packaged-WebView settings phase: $Phase"
  & node $nodeScript "$script:mainPort" $Phase
  if ($LASTEXITCODE -ne 0) { throw "Settings WebView2 phase '$Phase' failed with exit code $LASTEXITCODE." }
}

function Save-RunKeySnapshot {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKeyPath, $false)
  if (-not $key) { return }
  $script:runKeyExisted = $true
  foreach ($name in $key.GetValueNames()) {
    $script:runKeySnapshot[$name] = @{
      Value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      Kind = $key.GetValueKind($name).ToString()
    }
  }
  $key.Close()
}

function Test-TarteelRunEntry([string]$Name, [object]$Value) {
  return ("$Name $Value" -match '(?i)tarteel')
}

function Clear-TarteelRunEntriesForTest {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKeyPath, $true)
  if (-not $key) { return }
  foreach ($name in $key.GetValueNames()) {
    $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (Test-TarteelRunEntry $name $value) { $key.DeleteValue($name, $false) }
  }
  $key.Close()
}

function Restore-RunKeySnapshot {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runKeyPath)
  if (-not $key) { throw 'Could not reopen the current-user Run registry key for restoration.' }
  foreach ($name in @($key.GetValueNames())) {
    if (-not $script:runKeySnapshot.ContainsKey($name)) {
      $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if (Test-TarteelRunEntry $name $value) { $key.DeleteValue($name, $false) }
    }
  }
  foreach ($name in $script:runKeySnapshot.Keys) {
    $entry = $script:runKeySnapshot[$name]
    if (Test-TarteelRunEntry $name $entry.Value) {
      $kind = [System.Enum]::Parse([Microsoft.Win32.RegistryValueKind], $entry.Kind)
      $key.SetValue($name, $entry.Value, $kind)
    }
  }
  $key.Close()
  $verify = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKeyPath, $false)
  if (-not $verify) { throw 'The restored current-user Run registry key could not be verified.' }
  $actualNames = @($verify.GetValueNames())
  foreach ($name in $actualNames) {
    $value = $verify.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ((Test-TarteelRunEntry $name $value) -and -not $script:runKeySnapshot.ContainsKey($name)) {
      throw "Unexpected Tarteel startup registry value remains after restoration: $name"
    }
  }
  foreach ($name in $script:runKeySnapshot.Keys) {
    $entry = $script:runKeySnapshot[$name]
    if (-not (Test-TarteelRunEntry $name $entry.Value)) { continue }
    if ($actualNames -notcontains $name) { throw "Original Tarteel startup registry value was not restored: $name" }
    $actualValue = $verify.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $actualJson = ConvertTo-Json -Compress -InputObject $actualValue
    $expectedJson = ConvertTo-Json -Compress -InputObject $entry.Value
    if ($verify.GetValueKind($name).ToString() -ne $entry.Kind -or $actualJson -ne $expectedJson) {
      throw "Original Tarteel startup registry value differs after restoration: $name"
    }
  }
  $verify.Close()
  if (-not $script:runKeyExisted) {
    $check = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKeyPath, $false)
    if ($check) {
      $empty = ($check.GetValueNames().Count -eq 0) -and ($check.GetSubKeyNames().Count -eq 0)
      $check.Close()
      if ($empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($runKeyPath, $false) }
    }
  }
}

function Restore-Directory([string]$Path, [string]$BackupPath, [bool]$HadOriginal) {
  $backupExists = Test-Path $BackupPath
  if ($HadOriginal -and -not $backupExists) {
    if (Test-Path $Path) {
      Write-Warning "No backup exists for '$Path'; the original path is still present and will be left untouched."
      return
    }
    throw "The original path '$Path' and its expected backup '$BackupPath' are both missing."
  }
  if (-not $HadOriginal -and $backupExists) { throw "Unexpected backup for a path that did not exist before the test: $BackupPath" }
  for ($attempt = 0; (Test-Path $Path) -and $attempt -lt 6; $attempt++) {
    try { Remove-Item -Path $Path -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Seconds 1 }
  }
  if (Test-Path $Path) { throw "Could not remove the isolated test profile before restoring runner data: $Path" }
  if ($backupExists) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
    Move-Item -Path $BackupPath -Destination $Path -Force
  }
}

$existingTarteelTasks = @(Get-TarteelScheduledTaskNames)
if ($existingTarteelTasks.Count -gt 0) {
  throw "Refusing to alter pre-existing Tarteel Task Scheduler entries on the runner: $($existingTarteelTasks -join ', ')"
}
$script:initialTarteelTaskNames = @($existingTarteelTasks)
$tarteelProcessName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedExe)
$runningTarteelProcesses = @(Get-Process -Name $tarteelProcessName -ErrorAction SilentlyContinue)
if ($runningTarteelProcesses.Count -gt 0) {
  throw "Refusing to run the isolated settings test while another '$tarteelProcessName' process is active."
}
Save-RunKeySnapshot
New-Item -ItemType Directory -Force -Path $outDir, $testRoot, $sessionDir, $islandWebViewProfile, $backupDir | Out-Null

try {
  Clear-TarteelRunEntriesForTest
  if ($roamingOriginallyExisted) { Move-Item -Path $roamingAppData -Destination $roamingBackup -Force }
  if ($localOriginallyExisted) { Move-Item -Path $localAppData -Destination $localBackup -Force }
  $env:TARTEEL_SETTINGS_ARTIFACT_DIR = $outDir
  $env:TARTEEL_SETTINGS_SESSION_DIR = $sessionDir

  Start-TarteelForSmoke
  Invoke-NodePhase 'first'
  Record-TestCreatedTarteelTasks
  Stop-TarteelForSmoke

  Start-TarteelForSmoke
  Invoke-NodePhase 'verify'
  Record-TestCreatedTarteelTasks
  Invoke-NodePhase 'cleanup'
  Record-TestCreatedTarteelTasks
  Stop-TarteelForSmoke

  Write-Host 'SETTINGS_UI_SMOKE_STATUS=passed'
} finally {
  if ($script:process -and -not $script:process.HasExited) {
    try { Invoke-NodePhase 'cleanup' } catch { Write-Warning "IPC cleanup could not complete: $($_.Exception.Message)" }
    try { Stop-TarteelForSmoke } catch { Write-Warning $_.Exception.Message }
  }
  try { Remove-TestCreatedTarteelTasks } catch { $cleanupFailures.Add("Task Scheduler: $($_.Exception.Message)"); Write-Warning $cleanupFailures[$cleanupFailures.Count - 1] }
  try { Restore-RunKeySnapshot } catch { $cleanupFailures.Add("Autostart registry: $($_.Exception.Message)"); Write-Warning $cleanupFailures[$cleanupFailures.Count - 1] }
  try { Restore-Directory $roamingAppData $roamingBackup $roamingOriginallyExisted } catch { $cleanupFailures.Add("Roaming app data: $($_.Exception.Message)"); Write-Warning $cleanupFailures[$cleanupFailures.Count - 1] }
  try { Restore-Directory $localAppData $localBackup $localOriginallyExisted } catch { $cleanupFailures.Add("Local app data: $($_.Exception.Message)"); Write-Warning $cleanupFailures[$cleanupFailures.Count - 1] }
  foreach ($name in @('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','TARTEEL_WINDOWS_SMOKE_CDP','TARTEEL_WINDOWS_SMOKE_DEBUG_PORT','TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR','TARTEEL_SETTINGS_ISLAND_PORT','TARTEEL_SETTINGS_ARTIFACT_DIR','TARTEEL_SETTINGS_SESSION_DIR')) {
    $previous = switch ($name) {
      'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS' { $previousWebViewArgs }
      'TARTEEL_WINDOWS_SMOKE_CDP' { $previousSmokeCdpFlag }
      'TARTEEL_WINDOWS_SMOKE_DEBUG_PORT' { $previousSmokeCdpPort }
      'TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR' { $previousSmokeCdpDataDirectory }
      'TARTEEL_SETTINGS_ISLAND_PORT' { $previousSettingsIslandPort }
      'TARTEEL_SETTINGS_ARTIFACT_DIR' { $previousSettingsArtifactDir }
      'TARTEEL_SETTINGS_SESSION_DIR' { $previousSettingsSessionDir }
      default { $null }
    }
    if ($null -eq $previous) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item "Env:$name" $previous }
  }
  if ((Test-Path $roamingBackup) -or (Test-Path $localBackup)) {
    Write-Warning "Preserving $testRoot because a runner data backup could not be restored."
    $cleanupFailures.Add("Runner backup retained at $testRoot because restoration did not complete.")
  } elseif (Test-Path $testRoot) {
    Remove-Item -Path $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($cleanupFailures.Count -gt 0) { throw "Windows settings smoke cleanup failed: $($cleanupFailures -join '; ')" }
}
