import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bar = readFileSync(resolve(__dirname, '../bar.html'), 'utf8');
const lib = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
const appbar = readFileSync(resolve(__dirname, '../src-tauri/src/appbar.rs'), 'utf8');

describe('الشريط العلوي', () => {
  it('شفاف بالكامل: لا خلفية ولا ظل ولا خط فاصل', () => {
    const shell = bar.split('.bar{')[1].split('}')[0];
    expect(shell).toContain('background:transparent');
    expect(shell).not.toContain('box-shadow');
    expect(shell).not.toContain('border-bottom');
    expect(shell).not.toContain('backdrop-filter');
  });

  it('ثلاثة أقسام: التطبيق النشط، الجزيرة، المراقبات', () => {
    expect(bar).toContain('class="right"');
    expect(bar).toContain('class="mid"');
    expect(bar).toContain('class="left"');
  });

  it('يعرض كل المعلومات المتفق عليها', () => {
    for (const id of ['cpuVal', 'ramVal', 'netDown', 'vol', 'bright', 'wifiName', 'battVal', 'dotCam', 'dotMic', 'clockTime', 'clockDate', 'appName']) {
      expect(bar, id).toContain(`id="${id}"`);
    }
  });

  it('أزرار النافذة الثلاثة موجودة', () => {
    for (const id of ['wMin', 'wMax', 'wClose']) expect(bar).toContain(`id="${id}"`);
  });

  it('لا نص إنجليزي ظاهر للمستخدم', () => {
    /* نصوص الواجهة كلها عربية. الوسوم البرمجية وأسماء الأوامر مستثناة. */
    const visible = [...bar.matchAll(/>([^<>{}]+)</g)]
      .map(m => m[1].trim())
      .filter(t => t && /[A-Za-z]/.test(t) && !/^[\s\d.:—%↑↓]*$/.test(t));
    expect(visible, `نص لاتيني ظاهر: ${visible.join(' | ')}`).toEqual([]);
  });

  it('يتحدّث كل ثانية ولا يتوقف أبدًا', () => {
    /* document.hidden غير موثوق هنا: النافذة لا تُنشَّط أبدًا. */
    expect(bar).not.toContain('document.hidden');
    expect(bar).toContain('setInterval(refresh, 1000)');
  });

  it('الوسط يتسع مع توسّع الجزيرة فلا يمرّ النص تحتها', () => {
    expect(bar).toContain('--island-w');
    expect(bar).toContain("listen('island-state'");
  });
});

describe('تمركز الجزيرة داخل الشريط', () => {
  it('تُركَّز عموديًا لا تُوضع تحت الشريط', () => {
    /* كان الإزاحة ثابتة 10 بكسل، فبدأت الجزيرة من حدّ الشريط بالضبط. */
    expect(lib).not.toContain('(10.0 * scale)');
    expect(lib).toContain('(band as i64 - size.1 as i64) / 2');
  });

  it('ارتفاع الشريط يتبع مقياس العرض', () => {
    expect(lib).toContain('fn bar_height_px(scale: f64) -> i32');
    expect(lib).toContain('BAR_HEIGHT_LOGICAL');
  });

  it('ارتفاع الحجز يُضبط قبل الحجز لا بعده', () => {
    const setIdx = lib.indexOf('appbar::set_reserved_height(bar_height_px(scale))');
    /* أول حجز بعد ضبط الارتفاع — لا استدعاء أمر الواجهة في الأعلى. */
    const reserveIdx = lib.indexOf('appbar::reserve_with_new_window()', setIdx);
    expect(setIdx).toBeGreaterThan(-1);
    expect(reserveIdx).toBeGreaterThan(setIdx);
  });

  it('نافذة الشريط لا تسرق التركيز من تطبيق المستخدم', () => {
    expect(lib).toContain('WS_EX_NOACTIVATE');
    expect(lib).toContain('SWP_NOACTIVATE');
  });
});

describe('قائمة الأحجام المقبولة', () => {
  it('تقبل الحجمين الصغيرين الجديدين', () => {
    expect(lib).toContain('56.0');
    expect(lib).toContain('126.0');
    expect(lib).toContain('26.0');
  });

  it('ما زالت تقبل كل التوسعات', () => {
    for (const v of ['384.0', '440.0', '444.0', '480.0', '188.0', '210.0', '262.0']) {
      expect(lib, v).toContain(v);
    }
  });
});

describe('الحاجز يبقى غير مرئي', () => {
  it('لا سطح ولا لون للحاجز — حجز في مدير النوافذ فقط', () => {
    expect(appbar).not.toContain('WS_VISIBLE |');
    expect(appbar).toContain('SHAppBarMessage');
  });
});
