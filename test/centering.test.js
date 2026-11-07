import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const lib = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
const tray = readFileSync(resolve(__dirname, '../src-tauri/src/tray.rs'), 'utf8');
const cargo = readFileSync(resolve(__dirname, '../src-tauri/Cargo.toml'), 'utf8');
const geo = readFileSync(resolve(__dirname, '../src-tauri/src/geometry.rs'), 'utf8');
const html = readFileSync(resolve(__dirname, '../island.html'), 'utf8');

describe('تموضع الجزيرة عند أصل الشاشة', () => {
  it('يستخدم أصل الشاشة الحقيقي ولا يضيف إزاحة ثابتة', () => {
    expect(lib).not.toContain('(10.0 * scale)');
    expect(lib).toContain('geometry::island_origin(origin.x, origin.y');
    expect(geo).toContain('fn island_origin(monitor_left: i32, monitor_top: i32');
  });

  it('يحافظ على مرجع المرحلة الصغيرة بعد تمدد نافذة WebView', () => {
    expect(geo).toContain('COMPACT_STAGE_LOGICAL_HEIGHT: f64 = 38.0');
    expect(geo).toContain('fn compact_stage_height_px(scale: f64) -> i32');
    expect(html).toContain('compactStageHeight');
    expect(html).toContain('const top=Math.max(0,(compactStageHeight-TARGET.idle[1]*f)/2)');
  });

  it('يقيس CSS وRust الارتفاع نفسه على مقاييس DPI مختلفة', () => {
    expect(geo).toContain('fn scale_from_dpi');
    expect(geo).toContain('compact_stage_height_px');
    expect(lib).toContain('geometry::compact_stage_height_px(scale)');
  });

  it('اختبارات Rust تشمل الشاشة الثانوية والمرحلة المصغرة وموضع الإقلاع', () => {
    for (const name of [
      'compact_stage_and_anchor_scale_with_dpi',
      'island_is_centered_on_the_selected_monitor_and_uses_its_true_origin',
      'centering_stays_whole_pixels_with_odd_widths',
    ]) expect(geo).toContain(name);
    for (const name of [
      'island_bounds_are_derived_from_the_actual_monitor_origin',
      'island_boot_size_is_explicit_and_uses_the_compact_stage',
      'compact_stage_height_matches_css_at_every_scale',
      'a_second_monitor_is_centred_on_its_own_origin',
    ]) expect(lib).toContain(name);
  });

  it('يظل إغلاق نافذة الإعدادات منفصلًا عن إخفاء الجزيرة', () => {
    const hideToTray = tray.slice(tray.indexOf('pub fn hide_to_tray'), tray.indexOf('pub fn hide_all'));
    expect(hideToTray).toContain('MAIN_WINDOW');
    expect(hideToTray).not.toContain('ISLAND_WINDOW');
    expect(html).not.toContain('(window.innerHeight-h*f)/2');
  });
});

describe('نسخة واحدة من التطبيق', () => {
  it('قفل النسخة الواحدة مسجل قبل إنشاء أي نافذة', () => {
    const builder = lib.indexOf('tauri::Builder::default()');
    const lock = lib.indexOf('single_instance::init');
    const firstWindow = lib.indexOf('WebviewWindowBuilder::new');
    expect(lock).toBeGreaterThan(builder);
    expect(lock).toBeLessThan(firstWindow);
  });

  it('النقر على الاختصار مجددًا يظهر النافذة القائمة', () => {
    const cb = lib.slice(lib.indexOf('single_instance::init'), lib.indexOf('manage(server)'));
    expect(cb).toContain('get_webview_window("main")');
    expect(cb).toContain('window.show()');
  });

  it('الحزمة مضافة إلى الاعتماديات', () => {
    expect(cargo).toContain('tauri-plugin-single-instance');
  });
});

describe('الجزيرة تبقى بعد إغلاق النافذة', () => {
  it('إغلاق (X) يخفي النافذة الرئيسية وحدها', () => {
    const hideToTray = tray.slice(tray.indexOf('pub fn hide_to_tray'), tray.indexOf('pub fn hide_all'));
    expect(hideToTray).toContain('MAIN_WINDOW');
    expect(hideToTray).not.toContain('ISLAND_WINDOW');
  });

  it('الإخفاء الكامل منفصل ويستخدم عند الإقلاع في الخلفية فقط', () => {
    expect(tray).toContain('pub fn hide_all');
    const hideAll = tray.slice(tray.indexOf('pub fn hide_all'));
    expect(hideAll).toContain('ISLAND_WINDOW');
    expect(lib.split('tray::hide_all').length - 1).toBe(1);
    expect(lib).toContain('"--hidden"');
  });
});

describe('العمل الملغى غير موجود', () => {
  it('الملفات القديمة التي أزيلت سابقًا لا تعود', () => {
    for (const file of ['bar.html', 'src-tauri/src/sysmon.rs', 'src-tauri/src/winaction.rs', 'test/bar.test.js']) {
      expect(existsSync(resolve(__dirname, '..', file)), file).toBe(false);
    }
  });

  it('لا آثار لأوامر أو وحدات التطبيق الملغاة الأخرى', () => {
    expect(lib).not.toContain('sysmon');
    expect(lib).not.toContain('bar_snapshot');
    expect(lib).not.toContain('withGlobalTauri');
    const conf = readFileSync(resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8');
    expect(conf).not.toContain('"bar"');
    const vite = readFileSync(resolve(__dirname, '../vite.config.js'), 'utf8');
    expect(vite).not.toContain('bar.html');
  });
});
