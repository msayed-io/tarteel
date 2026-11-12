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

  it('restores the accepted 0.7.7 sizes and preserves the expanded-state internal layout', async () => {
    const html = await read('island.html');
    const target = html.match(/TARGET=\{idle:\[(\d+),(\d+),(\d+)\],compact:\[(\d+),(\d+),(\d+)\],full:\[(\d+),(\d+),(\d+)\],prayer:\[(\d+),(\d+),(\d+)\],tools:\[(\d+),(\d+),(\d+)\],alert:\[(\d+),(\d+),(\d+)\]\}/);
    expect(target).not.toBeNull();
    expect(target.slice(1, 4).map(Number)).toEqual([44, 24, 12]);
    expect(target.slice(4, 7).map(Number)).toEqual([112, 24, 11]);
    expect(target.slice(7, 10).map(Number)).toEqual([384, 210, 37]);
    expect(target.slice(10, 13).map(Number)).toEqual([400, 170, 40]);
    expect(target.slice(13, 16).map(Number)).toEqual([432, 270, 41]);
    expect(target.slice(16, 19).map(Number)).toEqual([396, 83, 36]);
    expect(html).toContain('[data-state=full] .full{transform:scale(.8)}');
    expect(html).toContain('[data-state=prayer] .prayer,[data-state=tools] .tools,[data-state=alert] .alert{transform:scale(.9)}');
    expect(html).toContain('.prayer{width:444px;height:188px');
    expect(html).toContain('.plist{flex:none;width:216px');
    expect(html).toContain('.full .art{left:18px;top:27px;width:90px;height:90px}');
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

  it('computes prayer times locally from a verified device location with no manual path', async () => {
    const astro = await read('src/engine/astro.js');
    const location = await read('src/engine/location.js');
    const settings = await read('src/PrayerSettingsPage.jsx');

    /* لا مصدر خارجي للمواقيت: الحساب فلكي محلي. */
    expect(astro).not.toContain('aladhan');
    expect(astro).not.toContain('fetch(');
    expect(astro).toContain('solarPosition');

    /* الموقع من WebView2 بدقة عالية — لا إضافة Tauri للموقع.
       إضافة tauri-plugin-geolocation لم تُظهر التطبيق في قائمة تطبيقات الموقع
       في ويندوز إطلاقًا، لأنها لا تمرّ بمسار إذن WebView2. */
    expect(location).toContain('navigator');
    expect(location).toContain('enableHighAccuracy: true');
    expect(location).toContain('tz-lookup');
    expect(location).not.toContain('requestPermissions');

    /* الموقع اليدوي وبحث المدن واختيار طريقة الحساب والضبط الدقيق أُزيلت. */
    expect(settings).not.toContain('اختيار يدوي');
    expect(settings).not.toContain('ps-city');
    expect(settings).not.toContain('طريقة حساب المواقيت');
    expect(settings).not.toContain('حساب صلاة العصر');
    expect(settings).not.toContain('ضبط دقيق');
    expect(settings).toContain('تحديث موقعي الآن');

    /* لا أثر لإضافة الموقع في الطبقة الأصلية. */
    const cargo = await read('src-tauri/Cargo.toml');
    const rust = await read('src-tauri/src/lib.rs');
    expect(cargo).not.toContain('tauri-plugin-geolocation');
    expect(rust).not.toContain('tauri_plugin_geolocation');

    /* الصوت والتنبيه المسبق والضبط الدقيق هي ما يخصّ المستخدم فعلًا. */
    expect(settings).toContain('صوت الأذان');
    expect(settings).toContain('تنبيه مسبق');
  });

  it('renders a full settings page with document scrolling and no modal backdrop', async () => {
    const css = await read('src/PrayerSettings.css');
    const settings = await read('src/PrayerSettingsPage.jsx');
    const main = await read('src/main.jsx');
    expect(css).toContain('max-width:1134px');
    expect(css).toContain('padding-inline:42px');
    expect(css).toContain('scrollbar-width:none');
    expect(css).toContain('body.settings-page-active');
    expect(css).not.toContain('prayer-settings-backdrop');
    expect(settings).toContain('className="settings-page"');
    expect(settings).toContain('id="pane-prayer"');
    expect(settings).toContain('id="pane-audio"');
    expect(settings).toContain('id="pane-island"');
    expect(settings).not.toContain('role="dialog"');
    expect(main).toContain('if (prayerSettingsOpen)');
    expect(main).not.toContain('{prayerSettingsOpen && <PrayerSettings');
    expect(settings).toContain('تحديث موقعي الآن');
    expect(settings).toContain('تجربة صوت الأذان');
    expect(settings).toContain('البدء مع تشغيل ويندوز');
    expect(settings).not.toContain('إظهار الضبط الدقيق');
  });

  it('adds a persistent Auto/Manual remote for Dynamic position and removes the rim intensity control', async () => {
    const settings = await read('src/PrayerSettingsPage.jsx');
    const logic = await read('src/PrayerSettings.jsx');
    const css = await read('src/PrayerSettings.css');
    const placement = await read('src/engine/island-placement.js');
    const rust = await read('src-tauri/src/lib.rs');
    const diagnostics = await read('src-tauri/src/island_diagnostics.rs');

    expect(settings).toContain('rim remote');
    expect(settings).toContain("chooseIslandPlacementMode('auto')");
    expect(settings).toContain("chooseIslandPlacementMode('manual')");
    expect(logic).toContain("invoke('get_island_placement')");
    expect(logic).toContain("invoke('set_island_placement'");
    for (const direction of ['up', 'right', 'down', 'left']) expect(settings).toContain(`nudgeIsland('${direction}')`);
    const upButton = settings.split('\n').find(line => line.includes('className="dp dp-up"')) ?? '';
    expect(upButton).toContain("disabled={placementLoading || islandPlacement.mode !== 'manual'}");
    expect(upButton).not.toContain('islandPlacement.offsetY <= 0');
    expect(placement).toContain('ISLAND_PLACEMENT_STEP = 2');
    expect(placement).toContain("mode: 'auto', offsetX: 0, offsetY: 0");
    expect(css).toContain('.settings-page .dp:active');
    expect(css).toContain('.settings-page .seg-item[aria-selected="true"]');
    expect(rust).toContain('const ISLAND_PLACEMENT_FILE: &str = "island-position.json"');
    expect(rust).toContain('fn get_island_placement(');
    expect(rust).toContain('fn set_island_placement(');
    expect(rust).toContain('geometry::island_origin_with_placement');
    expect(rust).toContain('island_position_motion_progress(progress)');
    expect(diagnostics).toContain('placement_offset_x_px');
    expect(diagnostics).toContain('placement_offset_y_px');
    expect(settings + logic).not.toContain('ps-rim-intensity');
    expect(settings + logic).not.toContain('شدة الحافة اللامعة');
  });

  it('uses one permission-gated system notification for the pre-alert and keeps prayer-time adhan separate', async () => {
    const main = await read('src/main.jsx');
    const start = main.indexOf("const preAlarmFiredRef = useRef(new Set(readJson('tarteel.prayer.pre-alerts', [])));");
    const end = main.indexOf('  const handleAdhan = payload => {', start);
    const preAlert = main.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(preAlert).toContain('config.notificationsAllowed');
    expect(preAlert).toContain('preAlarmFiredRef.current.add(firedId)');
    expect(preAlert).toContain("localStorage.setItem('tarteel.prayer.pre-alerts'");
    expect(preAlert).toContain('sendNotification({');
    expect(preAlert.match(/sendNotification\(/g)).toHaveLength(1);
    expect(preAlert).not.toContain('show_alarm_notification');
    expect(preAlert).not.toContain('play_adhan');
    const handlerStart = main.indexOf('  const handleAdhan = payload => {');
    const handlerEnd = main.indexOf('  /** التجربة تشغّل ملف الأذان', handlerStart);
    const handler = main.slice(handlerStart, handlerEnd);
    expect(handler).not.toContain('notificationsAllowed');
    expect(handler).not.toContain('sendNotification');
    expect(handler).not.toContain('show_alarm_notification');
    expect(main).toContain("invoke('play_adhan'");
    expect(main).not.toContain("invoke('fire_alarm_now'");
  });

  it('passes PrayerSettings exactly the props it destructures', async () => {
    /* عطل حقيقي: المكوّن قُرئ منه { config } بينما الأب كان يمرّر value،
       فصار config غير معرّف ورمى استثناء أثناء الرسم أفرغ الشجرة كلها
       => شاشة سوداء بالكامل في الإصدار 0.2.0. الفحص يمنع تكراره. */
    const main = await read('src/main.jsx');
    const settings = await read('src/PrayerSettings.jsx');
    const signature = settings.match(/export default function PrayerSettings\(\{([^}]*)\}\)/)[1];
    const expected = signature.split(',').map(part => part.trim().split(':')[0].trim()).filter(Boolean);
    const usage = main.match(/<PrayerSettings([\s\S]*?)\/>/)[1];
    const passed = [...usage.matchAll(/(\w+)=\{/g)].map(m => m[1]);
    for (const prop of expected) {
      expect(passed, `PrayerSettings expects prop "${prop}" but it is not passed`).toContain(prop);
    }
    /* وكل ما يُمرَّر يجب أن يكون مقروءًا فعليًا، وإلا كان خطأ صامتًا. */
    for (const prop of passed) {
      expect(expected, `main passes "${prop}" which PrayerSettings never reads`).toContain(prop);
    }
  });

  it('wraps the app in an error boundary so a crash cannot be a black screen', async () => {
    const main = await read('src/main.jsx');
    expect(main).toContain('class ErrorBoundary extends React.Component');
    expect(main).toContain('getDerivedStateFromError');
    expect(main).toContain('<ErrorBoundary><App/></ErrorBoundary>');
    /* لا يجوز إخفاء الخطأ: يجب أن تُعرض رسالته الحقيقية. */
    expect(main).toContain('error?.stack || error?.message');
  });

  it('every invoke in the interface has a matching Rust command', async () => {
    /* عطل حقيقي حدث: الواجهة كانت تنادي set_prayer_schedule بعد حذفه،
       فيفشل الجدول صامتًا وقت التشغيل. هذا الفحص يمنعه. */
    const main = await read('src/main.jsx');
    const settings = await read('src/PrayerSettings.jsx');
    const rust = await read('src-tauri/src/lib.rs');
    const handler = rust.match(/generate_handler!\[([\s\S]*?)\]/)[1];
    const registered = new Set(handler.match(/[a-z_]+/g));
    const invoked = new Set([...(main + settings).matchAll(/invoke\('([a-z_]+)'/g)].map(m => m[1]));
    expect(invoked.size).toBeGreaterThan(0);
    for (const command of invoked) {
      expect(registered.has(command), `invoke('${command}') has no Rust command`).toBe(true);
    }
  });

  it('wires the controls to the existing player, native schedule, notification, and sleep logic', async () => {
    const island = await read('island.html');
    const main = await read('src/main.jsx');
    const rust = await read('src-tauri/src/lib.rs');
    for (const event of ['player-state', 'prayer-data', 'prayer-adhan', 'prayer-resumed', 'sleep-deadline']) expect(island).toContain(`listen('${event}'`);
    for (const action of ['toggle', 'previous', 'next', 'seek', 'seek-by', 'set-speed', 'set-sleep', 'set-prayer-preference', 'resume-after-adhan', 'dismiss-adhan']) expect(main).toContain(`payload.action === '${action}'`);
    expect(main).toContain('audio.current.playbackRate = Number(next.speed)');
    expect(main).toContain("sleepMode: 'end'");
    /* المنظومة القديمة أُعيد بناؤها: الجدولة الآن تمرّ بـ set_alarm_schedule
       ومهام ويندوز، لا بأمر set_prayer_schedule القديم. */
    expect(rust).toContain('set_alarm_schedule');
    expect(rust).toContain('sync_windows_tasks');
    expect(rust).toContain('mod alarm;');
    expect(rust).toContain('mod task_scheduler;');
    /* حماية من تكرار الدوال: خطأ سابق في هذه الجلسة حذف أوامر المشغّل الأساسية
       وكرّر أخرى. لكل دالة يجب أن يظهر تعريف واحد فقط. */
    for (const fn of ['scan_directory', 'set_audio_root', 'audio_url', 'resize_island',
      'island_bounds_from_monitor', 'apply_island_bounds', 'set_alarm_schedule',
      'set_sleep_deadline', 'sync_windows_tasks', 'deliver_alarm', 'now_ms']) {
      const declarations = rust.split(`fn ${fn}(`).length - 1;
      expect(declarations, `fn ${fn} must be declared exactly once`).toBe(1);
    }
    expect(rust).toContain('tauri_plugin_notification::init()');
    expect(rust).toContain('WindowEvent::CloseRequested');
  });

  it('keeps the island borderless/transparent, accurately positioned, and alive on minimize only', async () => {
    const html = await read('island.html');
    const rust = await read('src-tauri/src/lib.rs');
    expect(html).not.toContain('setSize(');
    expect(html).not.toContain('setPosition(');
    /* الحجم يأتي من الشاشة الفعلية عبر island_bounds_from_monitor، لا من
       رقم ثابت لا يعرف مقياس العرض. */
    expect(rust).toContain('island_bounds_from_monitor');
    expect(rust).toContain('geometry::island_origin');
    expect(rust).toContain('.transparent(true)');
    expect(rust).toContain('.background_color');
    expect(rust).toContain('.shadow(false)');
    const islandBuilder = rust.split('WebviewWindowBuilder::new(app, "island"')[1].split('.build()?')[0];
    expect(islandBuilder).not.toContain('.parent(');
    expect(rust).toContain('frame::strip_frame');
    expect(rust).toContain('hittest::attach');
    expect(rust).toContain('hittest::set_collapsed_window_region');
    expect(rust).toContain('hittest::clear_window_region');
    expect(rust).toContain('window.label() != "main"');
    /* تغيّر مقصود في v0.6.0: (X) يُخفي إلى الصينية ولا يقتل العملية، لأن
       قتلها يُلغي الأذان. الخروج النهائي من قائمة الصينية وحدها. */
    expect(rust).toContain('api.prevent_close()');
    expect(rust).toContain('tray::hide_to_tray');
    /* الخروج النهائي معرّف في tray.rs لا في lib.rs. */
    const tray = await read('src-tauri/src/tray.rs');
    expect(tray).toContain('QUIT_ID');
    expect(tray).toContain('app.exit(0)');
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
    expect(html).not.toContain('.island::before');
    expect(html).not.toContain('NECK_HEIGHT');
  });

  it('never re-centres a window that is still resizing', async () => {
    const rust = await read('src-tauri/src/lib.rs');
    const resizeBody = rust.split('fn resize_island')[1].split('\n}')[0];
    // set_position must not read a stale in-flight inner_size() to compute the anchor.
    expect(resizeBody).not.toContain('inner_size');
    expect(resizeBody).toContain('geometry::island_origin');
    // Position and size must reach the window manager as ONE call, otherwise a frame can
    // render with the new width but the old centre, which is the collapse-time shake.
    expect(resizeBody).not.toContain('set_position');
    expect(resizeBody).not.toContain('set_size');
    expect(resizeBody).toContain('run_on_main_thread');
    const rustFile = await read('src-tauri/src/lib.rs');
    const atomic = rustFile.split('fn apply_island_bounds_native')[1].split('\n}')[0];
    expect(atomic).toContain('SetWindowPos');
    expect(atomic).toContain('SWP_NOACTIVATE');
    // A failed native resize must not start an animation in a clipped/stale WebView.
    const island = await read('island.html');
    const goBody = island.split('async function go(')[1].split('async function')[0];
    expect(goBody).toContain('catch(cause){reportWindowError(cause);return}');
    expect(island).toContain('async function waitForViewportSize(width,height)');
    expect(island).toContain('const ask=++hostSeq');
    // The native window is a fixed stage that only grows. Shrinking it back after the
    // collapse made the WebView repaint at the old centre for a frame, which is the shake.
    // v0.1.5 never resized the window at all, and it was smooth.
    expect(island).not.toContain('shrinkHostWhenSettled');
    const tickBody = island.split('function tick(now)')[1].split('const kick=')[0];
    expect(tickBody).not.toContain('resize');
    expect(tickBody).not.toContain('host');
  });

  it('damps island springs without changing the established anchor or collapse sizing', async () => {
    const island = await read('island.html');
    const springs = [...island.matchAll(/mk\(\d+,(\d+),(\d+)\)/g)].map(match => [Number(match[1]), Number(match[2])]);
    expect(springs).toHaveLength(3);
    for (const [stiffness, damping] of springs) {
      expect(damping * damping).toBeGreaterThanOrEqual(4 * stiffness);
    }
    expect(island).toContain('if(width>host.width||requiredHeight>host.height)');
    expect(island).toContain('back=state');
    expect(island).not.toContain('shrinkHostWhenSettled');
  });
});
