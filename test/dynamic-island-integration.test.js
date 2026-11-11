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
    const meter = main.slice(main.indexOf('const publishLevels ='), main.indexOf("a.addEventListener('timeupdate'"));
    expect(main).toContain("emit('audio-levels', { audioState, levels, rms, peak })");
    expect(main).toContain('a.captureStream()');
    expect(main).toContain("audio.current.crossOrigin = 'anonymous'");
    expect(main).toContain('createMediaStreamSource(stream)');
    expect(main).toContain('getFloatTimeDomainData(meter.samples)');
    expect(island).toContain("listen('audio-levels'");
    expect(meter).not.toContain('setInterval(');
    expect(island).toContain('transform:scaleY(var(--level,.07))');
    expect(island).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
    expect(island).toContain('reducedMotion.matches?200:32');
    expect(island).not.toContain('@keyframes eq');
    expect(main).not.toContain('createMediaElementSource');
    expect(meter).toContain('cancelAnimationFrame(meter.raf)');
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
