import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

const read = path => readFile(path, 'utf8');

describe('Tarteel production surface', () => {
  it('contains no bundled sample recitations or demo prayer schedule', async () => {
    const source = await read('src/main.jsx');
    const island = await read('island.html');
    expect(source).not.toContain('عبدالله القرافي');
    expect(source).not.toContain('سورة الروم');
    expect(island).not.toMatch(/demoAt|CONFIG\.simulate|data-act=adhan|data-go=/);
    expect(island).not.toContain('setPrayerTimes');
    expect(island).not.toContain('setTimeout(() => go(');
  });

  it('keeps Arabic application direction', async () => {
    const html = await read('index.html');
    expect(html).toContain('lang="ar" dir="rtl"');
  });

  it('preserves the reference layout geometry and scales only the expanded player to 80%', async () => {
    const html = await read('island.html');
    const target = html.match(/TARGET=\{idle:\[(\d+),(\d+),(\d+)\],compact:\[(\d+),(\d+),(\d+)\],full:\[(\d+),(\d+),(\d+)\],prayer:\[(\d+),(\d+),(\d+)\],tools:\[(\d+),(\d+),(\d+)\],alert:\[(\d+),(\d+),(\d+)\]\}/);
    expect(target).not.toBeNull();
    expect(target.slice(1, 4).map(Number)).toEqual([64, 34, 17]);
    expect(target.slice(4, 7).map(Number)).toEqual([144, 34, 17]);
    expect(target.slice(7, 10).map(Number)).toEqual([384, 210, 37]);
    expect(html).toContain('[data-state=full] .full{transform:scale(.8)}');
    expect(html).toContain('.prayer{width:444px;height:188px');
    expect(html).toContain('.plist{flex:none;width:216px');
    expect(html).toContain('width:82px;height:82px;flex:0 0 82px');
    expect(html).toContain('.tools{width:480px;height:auto');
    expect(html).toContain('.alert{width:440px;height:92px');
  });

  it('retains the exact reference control groups and excludes removed save/repeat controls', async () => {
    const html = await read('island.html');
    for (const id of ['chSpeed', 'chSleep', 'swCount', 'swPause', 'plab', 'pnm', 'pcd', 'plist', 'prayerCountRing', 'alT', 'alS', 'alR', 'alD']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toMatch(/حفظ|تكرار|repeat|bookmark/i);
    expect(html).toContain('عرض الصلاة القادمة');
    expect(html).toContain('إيقاف التلاوة عند الأذان');
  });

  it('feeds the interface only with verified location-based prayer times and supports manual locations', async () => {
    const prayer = await read('src/prayer.js');
    const settings = await read('src/PrayerSettings.jsx');
    expect(prayer).toContain('api.aladhan.com/v1');
    expect(prayer).toContain('geocoding-api.open-meteo.com/v1/search');
    expect(prayer).toContain("permission?.location !== 'granted'");
    expect(prayer).toContain('لم تُنشأ إحداثيات بديلة');
    expect(prayer).toContain('methodId');
    expect(prayer).toContain('school');
    expect(prayer).toContain('timezone');
    expect(settings).toContain('اختيار يدوي');
    expect(settings).toContain('AlAdhan');
  });

  it('wires the controls to the existing player, native schedule, notification, and sleep logic', async () => {
    const island = await read('island.html');
    const main = await read('src/main.jsx');
    const rust = await read('src-tauri/src/lib.rs');
    for (const event of ['player-state', 'prayer-data', 'prayer-adhan', 'prayer-resumed', 'sleep-deadline']) expect(island).toContain(`listen('${event}'`);
    for (const action of ['seek-by', 'set-speed', 'set-sleep', 'set-prayer-preference', 'resume-after-adhan']) expect(main).toContain(`payload.action === '${action}'`);
    expect(main).toContain('audio.current.playbackRate = Number(next.speed)');
    expect(main).toContain("sleepMode: 'end'");
    /* المنظومة القديمة أُعيد بناؤها: الجدولة الآن تمرّ بـ set_alarm_schedule
       ومهام ويندوز، لا بأمر set_prayer_schedule القديم. */
    expect(rust).toContain('set_alarm_schedule');
    expect(rust).toContain('sync_windows_tasks');
    expect(rust).toContain('mod alarm;');
    expect(rust).toContain('mod task_scheduler;');
    expect(rust).toContain('tauri_plugin_notification::init()');
    expect(rust).toContain('WindowEvent::CloseRequested');
  });

  it('keeps the island borderless/transparent, accurately positioned, and alive on minimize only', async () => {
    const html = await read('island.html');
    const rust = await read('src-tauri/src/lib.rs');
    expect(html).not.toContain('setSize(');
    expect(html).not.toContain('setPosition(');
    expect(rust).toContain('.inner_size(480.0, 262.0)');
    expect(rust).toContain('.transparent(true)');
    expect(rust).toContain('.background_color');
    expect(rust).toContain('.shadow(false)');
    const islandBuilder = rust.split('WebviewWindowBuilder::new(app, "island"')[1].split('.build()?')[0];
    expect(islandBuilder).not.toContain('.parent(');
    expect(rust).toContain('centered_island_origin');
    expect(rust).toContain('window.label() == "main"');
    expect(rust).toContain('island.destroy()');
    expect(rust).not.toContain('WindowEvent::Focused(false)');
  });

  it('paints no shadow, border or second rectangle behind or around the island', async () => {
    const html = await read('island.html');
    const islandShell = html.split('.island{')[1].split('}')[0];
    expect(islandShell).not.toContain('box-shadow');
    expect(islandShell).not.toContain('border:');
    // The former growth-driven drop shadow is gone from both the style and the script.
    expect(html).not.toContain('--p,0');
    expect(html).not.toContain("setProperty('--p'");
  });

  it('never re-centres a window that is still resizing', async () => {
    const rust = await read('src-tauri/src/lib.rs');
    const resizeBody = rust.split('fn resize_island')[1].split('\n}')[0];
    // set_position must not read a stale in-flight inner_size() to compute the anchor.
    expect(resizeBody).not.toContain('inner_size');
    expect(resizeBody).toContain('centered_island_origin');
    // Position and size must reach the window manager as ONE call, otherwise a frame can
    // render with the new width but the old centre, which is the collapse-time shake.
    expect(resizeBody).not.toContain('set_position');
    expect(resizeBody).not.toContain('set_size');
    expect(resizeBody).toContain('run_on_main_thread');
    const rustFile = await read('src-tauri/src/lib.rs');
    const atomic = rustFile.split('fn apply_island_bounds_native')[1].split('\n}')[0];
    expect(atomic).toContain('SetWindowPos');
    expect(atomic).toContain('SWP_NOACTIVATE');
    // The transition must still complete when the window grows or shrinks.
    const island = await read('island.html');
    const goBody = island.split('async function go(')[1].split('async function')[0];
    expect(goBody).not.toContain('reportWindowError(cause);return');
    expect(island).toContain('const ask=++hostSeq');
    // The native window is a fixed stage that only grows. Shrinking it back after the
    // collapse made the WebView repaint at the old centre for a frame, which is the shake.
    // v0.1.5 never resized the window at all, and it was smooth.
    expect(island).not.toContain('shrinkHostWhenSettled');
    const tickBody = island.split('function tick(now)')[1].split('const kick=')[0];
    expect(tickBody).not.toContain('resize');
    expect(tickBody).not.toContain('host');
  });
});
