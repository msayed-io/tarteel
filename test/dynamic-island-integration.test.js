import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const read = path => readFile(path, 'utf8');

describe('selective Dynamic Island update', () => {
  it('keeps the existing island states and geometry while separating view from audio state', async () => {
    const island = await read('island.html');
    expect(island).toContain('idle:[44,24,12],compact:[112,24,11],full:[384,210,37],prayer:[400,170,40],tools:[432,270,41],alert:[396,83,36]');
    expect(island).toContain('data-view-state="idle" data-audio-state="no-track"');
    expect(island).toContain("next==='compact'?'music':next==='full'?'expanded':next");
    expect(island).toContain("audioState=['no-track','playing','paused','ended']");
    expect(island).not.toContain("if(!data.fileName&&state==='compact')go('idle')");
    for (const state of ['prayer', 'tools', 'alert']) expect(island).toContain(`[data-state=${state}]`);
  });

  it('maps pointer directions to current states and cancels interrupted gestures', async () => {
    const island = await read('island.html');
    for (const token of ['setPointerCapture', "window.addEventListener('pointerup'", "addEventListener('pointercancel'", "addEventListener('lostpointercapture'", "addEventListener('blur'", "addEventListener('visibilitychange'"]) {
      expect(island).toContain(token);
    }
    expect(island).toContain('.layer.idle,.layer.compact,.layer.full,.layer.prayer,.layer.alert{touch-action:none}.layer.tools{touch-action:pan-y}');
    expect(island).toContain('SWIPE_DISTANCE=30,FLICK_DISTANCE=14,FLICK_VELOCITY=.55,AXIS_DOMINANCE=1.2');
    expect(island).toContain("if(state==='idle')go('compact')");
    expect(island).toContain("if(dx<0)go('prayer');else go('idle')");
    expect(island).toContain("if(state==='full')go('compact')");
    expect(island).toContain("event.target.closest('.ctl,.bar,.tbtn,.tools,.alert,.empty-actions')");
  });

  it('renders the empty music state using the existing player and library actions only', async () => {
    const island = await read('island.html');
    const main = await read('src/main.jsx');
    expect(island).toContain('id="musicEmpty"');
    expect(island).toContain('id="emptyPlay"');
    expect(island).toContain('id="emptyLibrary"');
    expect(island).toContain("$('#emptyPlay').addEventListener('click',event=>{event.stopPropagation();control('toggle')})");
    expect(island).toContain("$('#emptyLibrary').addEventListener('click',event=>{event.stopPropagation();control('open-library')})");
    expect(main).toContain('if (payload.action === \'open-library\') controlsRef.current.openLibrary()');
    expect(main).toContain('const appWindow = getCurrentWindow()');
    expect(main).toContain('await appWindow.show()');
    expect(main).toContain('await appWindow.setFocus()');
  });

  it('uses only measured playback data for bars and leaves the original audio route untouched', async () => {
    const island = await read('island.html');
    const main = await read('src/main.jsx');
    const meter = main.slice(main.indexOf('const publishLevels ='), main.indexOf('a.muted = false;'));
    expect(main).toContain("emit('audio-levels', { audioState, levels, rms, peak })");
    expect(main).toContain('a.captureStream()');
    expect(main).toContain("audio.current.crossOrigin = 'anonymous'");
    expect(main).toContain('createMediaStreamSource(stream)');
    expect(main).toContain('getFloatTimeDomainData(meter.samples)');
    expect(meter).toContain('const onPlaying = () => startMeter()');
    expect(meter).toContain("a.addEventListener('playing', onPlaying)");
    expect(main).toContain("a.removeEventListener('playing', onPlaying)");
    expect(meter).toContain('if (meter.analyser && meter.sourceUrl === a.currentSrc) return meter');
    expect(meter).toContain('const onEmptied = () => resetMeterSource()');
    expect(meter).toContain("a.addEventListener('emptied', onEmptied)");
    expect(main).toContain("a.removeEventListener('emptied', onEmptied)");
    expect(meter).toContain('sourceUrl: a.currentSrc');
    expect(island).toContain("listen('audio-levels'");
    expect(meter).not.toContain('setInterval(');
    expect(island).toContain('transform:scaleY(var(--level,.07))');
    expect(island).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
    expect(island).toContain('reducedMotion.matches?200:32');
    expect(island).not.toContain('@keyframes eq');
    expect(main).not.toContain('createMediaElementSource');
    expect(meter).toContain('cancelAnimationFrame(meter.raf)');
  });

  it('isolates the Windows WebView2 audio smoke test on a free diagnostic port', async () => {
    const smoke = await read('scripts/windows-island-smoke.ps1');
    const meter = await read('test/windows-audio-meter.mjs');
    const rust = await read('src-tauri/src/lib.rs');
    expect(smoke).toContain('[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)');
    expect(smoke).toContain("$env:TARTEEL_WINDOWS_SMOKE_CDP = '1'");
    expect(smoke).toContain('$env:TARTEEL_WINDOWS_SMOKE_DEBUG_PORT = "$webViewDebugPort"');
    expect(smoke).toContain('$env:TARTEEL_WINDOWS_SMOKE_WEBVIEW_DATA_DIR = $webViewProfile');
    expect(smoke).toContain('Wait-WebViewDebugPort 30');
    expect(smoke).toContain('Process diagnostics: $details');
    expect(smoke).toContain('Choose|Browse|Folder|Directory');
    expect(smoke).toContain('All UIA windows:');
    const folderDialogSearch = smoke.slice(smoke.indexOf('function Get-FolderDialog'), smoke.indexOf('function Select-MainAudioFolder'));
    expect(folderDialogSearch).toContain('[System.Windows.Automation.TreeScope]::Descendants');
    expect(smoke).toContain('$script:mainWindow = $ancestor');
    const mainButtonSearch = smoke.slice(smoke.indexOf('function Find-MainButton'), smoke.indexOf('function Wait-MainTrack'));
    expect(mainButtonSearch).toContain('$mainWindow = $script:mainWindow');
    expect(mainButtonSearch).toContain('$mainWindow.FindAll(');
    expect(mainButtonSearch).not.toContain('RootElement');
    const folderPicker = smoke.slice(smoke.indexOf('function Select-MainAudioFolder'), smoke.indexOf('function Invoke-MainTrack'));
    expect(folderPicker).toContain('$button.Current.BoundingRectangle');
    expect(folderPicker).toContain('SetCursorPos($x, $y)');
    expect(folderPicker).toContain('mouse_event(0x0002');
    expect(folderPicker).toContain('mouse_event(0x0004');
    expect(folderPicker).toContain('WindowFromPoint($point)');
    expect(folderPicker).toContain('GetAncestor($hitHwnd, 2)');
    expect(folderPicker).toContain('SetForegroundWindow($mainHwnd)');
    expect(folderPicker).toContain('GetAncestor($dialogHwnd, 2)');
    expect(folderPicker).toContain('SetForegroundWindow($dialogRootHwnd)');
    expect(folderPicker).not.toContain('$dialog.SetFocus()');
    expect(folderPicker).toContain('Folder-dialog candidate:');
    expect(folderPicker).toContain('Set-Clipboard -Value $FolderPath -ErrorAction Stop');
    expect(folderPicker).toContain("[System.Windows.Forms.SendKeys]::SendWait('%d')");
    expect(folderPicker).toContain("[System.Windows.Forms.SendKeys]::SendWait('^a')");
    expect(folderPicker).toContain("[System.Windows.Forms.SendKeys]::SendWait('^v')");
    expect(folderPicker).not.toContain('[System.Windows.Automation.ValuePattern]::Pattern');
    expect(folderPicker).toContain('Start-Sleep -Milliseconds 400');
    expect(folderPicker).toContain('$navigationDeadline = (Get-Date).AddSeconds(15)');
    expect(folderPicker).toContain('FromHandle($dialogRootHwnd)');
    expect(folderPicker).toContain('UIA folder-picker enumeration attempt $navigationAttempts failed; retrying before deadline: $lastUiAutomationError');
    expect(folderPicker).toContain("navigationAttempts=$navigationAttempts; lastUiAutomationError='$lastUiAutomationError'");
    expect(folderPicker).toContain('if ($pathVisible -and $null -ne $select) { break }');
    expect(folderPicker).toContain('if ($null -eq $dialog -or (-not $pathVisible -or $null -eq $select))');
    expect(folderPicker).toContain('[System.Windows.Automation.Condition]::TrueCondition');
    expect(folderPicker).toContain("$expectedPathPattern = [regex]::Escape($FolderPath) + '\\s*$'");
    expect(folderPicker).toContain('$info.Name -match $expectedPathPattern');
    const swipeInput = smoke.slice(smoke.indexOf('function Swipe-IslandOffset'), smoke.indexOf('function Find-IslandElement'));
    expect(swipeInput).toContain("$compactUpFlick = $Record.state -eq 'compact' -and $OffsetXCss -eq 0 -and $OffsetYCss -lt 0");
    expect(swipeInput).toContain('$startY = [double]$rect.bottom - 1');
    expect(swipeInput).toContain('$steps = 1');
    expect(swipeInput).toContain('$effectiveDurationMs = 1');
    expect(swipeInput).toContain('[TarteelUiSmokeNative]::GetCursorPos([ref]$actualStart)');
    expect(swipeInput).toContain('velocity=$velocityCssPerMs CSS px/ms');
    expect(swipeInput).toContain('$stepDelayMs = [int][Math]::Max($minimumStepDelayMs, $effectiveDurationMs / $steps)');
    expect(smoke).toContain('recent measured rows: $recentRows');
    expect(smoke).toContain("$idleBeforeEmptySwipe = Wait-ForRow 'idle' 15");
    expect(smoke).toContain("$idleAfterMusic = Wait-ForRow 'idle' 15");
    expect(folderPicker).toContain('$info.IsEnabled');
    expect(folderPicker).toContain('[System.Windows.Automation.InvokePattern]::Pattern');
    expect(folderPicker).toContain('[System.Windows.Automation.LegacyIAccessiblePattern]::Pattern');
    expect(folderPicker).toContain("Physically clicked the verified native folder selection element");
    expect(folderPicker).toContain("Capture-Top 'folder-picker-navigation-failed'");
    expect(folderPicker).toContain("^(Select|Choose|Open|اختر|اختيار|تحديد|موافق)(\\s|$)");
    expect(rust).toContain('TARTEEL_WINDOWS_SMOKE_CDP');
    expect(rust).toContain('.additional_browser_args(&browser_args)');
    expect(rust).toContain('.data_directory(PathBuf::from(data_directory))');
    expect(rust).toContain('--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection');
    const startup = smoke.slice(smoke.indexOf("$env:TARTEEL_WINDOWS_SMOKE_CDP = '1'"), smoke.indexOf('$savedAnchor = $collapsed.capsule_anchor_center_screen'));
    expect(startup.indexOf('Wait-WebViewDebugPort 30')).toBeGreaterThanOrEqual(0);
    expect(startup).not.toContain('Remove-Item Env:TARTEEL_WINDOWS_SMOKE_CDP');
    const restart = smoke.slice(smoke.indexOf('$savedAnchor = $collapsed.capsule_anchor_center_screen'), smoke.indexOf("$previousSmokeFlag = $env:TARTEEL_WINDOWS_SMOKE_TEST", smoke.indexOf('$savedAnchor = $collapsed.capsule_anchor_center_screen')));
    expect(restart.indexOf('Remove-Item Env:TARTEEL_WINDOWS_SMOKE_CDP')).toBeGreaterThanOrEqual(0);
    expect(restart.indexOf('Remove-Item Env:TARTEEL_WINDOWS_SMOKE_CDP')).toBeLessThan(restart.indexOf('Stop-Process'));
    expect(meter).toContain('cause?.cause');
  });

  it('preserves the prayer and adhan UI and all pre-existing player operations', async () => {
    const island = await read('island.html');
    const main = await read('src/main.jsx');
    for (const id of ['prayerCountRing', 'plist', 'swCount', 'swPause', 'alT', 'alS', 'alR', 'alD', 'chSpeed', 'chSleep']) {
      expect(island).toContain(`id="${id}"`);
    }
    for (const action of ['toggle', 'previous', 'next', 'seek', 'set-speed', 'set-sleep', 'resume-after-adhan', 'stop-adhan', 'dismiss-adhan']) {
      expect(main).toContain(`payload.action === '${action}'`);
    }
    expect(main).toContain("invoke('play_adhan'");
    expect(main).toContain("invoke('stop_adhan'");
  });
});
