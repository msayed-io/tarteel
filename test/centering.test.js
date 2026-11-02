import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const lib = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
const tray = readFileSync(resolve(__dirname, '../src-tauri/src/tray.rs'), 'utf8');
const cargo = readFileSync(resolve(__dirname, '../src-tauri/Cargo.toml'), 'utf8');

describe('تموضع الجزيرة داخل الشريط', () => {
  it('التمركز يُحسب من الشاشة الحقيقية، لا بإزاحة ثابتة', () => {
    /* الخطأ السابق: 10*scale إزاحة ثابتة، فالجزيرة تبدأ عند حدّ الشريط.
       الآن المصدر الوحيد للحقيقة هو geometry::island_origin. */
    expect(lib).not.toContain('(10.0 * scale)');
    expect(lib).toContain('geometry::island_origin');
  });

  it('الكبسولة تُرسم في منتصف الشريط رأسياً', () => {
    expect(lib).toContain('geometry::island_floor_height_px');
    const html = readFileSync(resolve(__dirname, '../island.html'), 'utf8');
    expect(html).toContain('(window.innerHeight-h)/2');
  });

  it('ارتفاع الشريط واعٍ بمقياس العرض', () => {
    /* انتقل المصدر إلى geometry.rs: معامل واحد يشتق الاثنين. */
    const geo = readFileSync(resolve(__dirname, '../src-tauri/src/geometry.rs'), 'utf8');
    expect(geo).toContain('fn bar_height_px(scale: f64) -> i32');
    expect(geo).toContain('fn scale_from_dpi');
    expect(geo).toContain('BAR_LOGICAL_HEIGHT');
  });

  it('اختبارات Rust تفرض تمركزًا متماثلًا في كل الحالات', () => {
    for (const name of [
      'island_is_vertically_centred_inside_the_reserved_band',
      'small_island_has_three_pixels_above_and_below',
      'island_is_not_glued_to_the_top_edge',
      'island_never_starts_below_the_band',
      'centring_is_symmetric_across_display_scales',
    ]) {
      expect(lib, name).toContain(name);
    }
  });

  it('الاختبار القديم الذي كان يثبّت الإزاحة الخاطئة أُزيل', () => {
    /* كان يتوقع y=10 ويسمّيه «الهامش العلوي» فيمرّر الخطأ. */
    expect(lib).not.toContain('assert_eq!(y, 10');
  });
});

describe('نسخة واحدة من التطبيق', () => {
  it('قفل النسخة الواحدة مُسجَّل قبل أي نافذة', () => {
    const builder = lib.indexOf('tauri::Builder::default()');
    const lock = lib.indexOf('single_instance::init');
    const firstWindow = lib.indexOf('WebviewWindowBuilder::new');
    expect(lock).toBeGreaterThan(builder);
    expect(lock).toBeLessThan(firstWindow);
  });

  it('النقر على الاختصار مجددًا يُظهر النافذة القائمة', () => {
    const cb = lib.slice(lib.indexOf('single_instance::init'), lib.indexOf('manage(server)'));
    expect(cb).toContain('get_webview_window("main")');
    expect(cb).toContain('window.show()');
  });

  it('الحزمة مضافة إلى الاعتماديات', () => {
    expect(cargo).toContain('tauri-plugin-single-instance');
  });
});

describe('الجزيرة تبقى بعد إغلاق النافذة', () => {
  it('إغلاق (X) يُخفي النافذة الرئيسية وحدها', () => {
    const hideToTray = tray.slice(tray.indexOf('pub fn hide_to_tray'), tray.indexOf('pub fn hide_all'));
    expect(hideToTray).toContain('MAIN_WINDOW');
    expect(hideToTray).not.toContain('ISLAND_WINDOW');
  });

  it('إخفاء الكل دالة منفصلة، تُستخدم للإقلاع في الخلفية فقط', () => {
    expect(tray).toContain('pub fn hide_all');
    const hideAll = tray.slice(tray.indexOf('pub fn hide_all'));
    expect(hideAll).toContain('ISLAND_WINDOW');
    /* في lib.rs: hide_all يُستدعى مع --hidden فقط. */
    const calls = lib.split('tray::hide_all').length - 1;
    expect(calls).toBe(1);
    expect(lib).toContain('"--hidden"');
  });
});

describe('لا شيء من العمل الملغى باقٍ', () => {
  it('ملفات الشريط الملغى محذوفة تمامًا', () => {
    for (const f of ['bar.html', 'src-tauri/src/sysmon.rs', 'src-tauri/src/winaction.rs', 'test/bar.test.js']) {
      expect(existsSync(resolve(__dirname, '..', f)), f).toBe(false);
    }
  });

  it('لا آثار للأوامر أو الوحدات الملغاة', () => {
    expect(lib).not.toContain('sysmon');
    expect(lib).not.toContain('bar_snapshot');
    expect(lib).not.toContain('withGlobalTauri');
    const conf = readFileSync(resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8');
    expect(conf).not.toContain('"bar"');
    const vite = readFileSync(resolve(__dirname, '../vite.config.js'), 'utf8');
    expect(vite).not.toContain('bar.html');
  });
});
