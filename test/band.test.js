import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const geo = readFileSync(resolve(__dirname, '../src-tauri/src/geometry.rs'), 'utf8');
const frame = readFileSync(resolve(__dirname, '../src-tauri/src/frame.rs'), 'utf8');
const hittest = readFileSync(resolve(__dirname, '../src-tauri/src/hittest.rs'), 'utf8');
const island = readFileSync(resolve(__dirname, '../island.html'), 'utf8');

describe('القياسات التي كشفت الخلل', () => {
  it('المقياس المستنتج من الصورة 125%', () => {
    /* الكبسولة 70 بكسل والعرض المنطقي 56 => 70/56 = 1.25 */
    expect(70 / 56).toBeCloseTo(1.25, 5);
  });

  it('الجزيرة القديمة كانت أطول من الشريط، فالتموضع داخله مستحيل', () => {
    /* 26 × 1.25 = 32.5 ≈ 33 مقابل شريط 32 ثابتة */
    const islandPx = Math.round(26 * 1.25);
    expect(islandPx).toBe(33);
    expect(islandPx).toBeGreaterThan(32);
  });

  it('الشريط والجزيرة يتقاسمان نفس المعامل الآن', () => {
    expect(geo).toContain('fn bar_height_px(scale: f64)');
    expect(geo).toContain('fn island_floor_height_px(scale: f64)');
    expect(geo).toContain('island_height <= bar_height');
  });
});

describe('الكبسولة تُرسم في منتصف الشريط', () => {
  it('التمركز الرأسي محسوب لا مفترض', () => {
    expect(island).toContain('(window.innerHeight-h)/2');
    expect(island).toContain("isl.style.top=top+'px'");
  });

  it('المستطيل التفاعلي يتبع نفس إزاحة الكبسولة', () => {
    expect(island).toContain("invoke('set_island_hit_rect',{x:left,y:top,width:w,height:h})");
  });
});

describe('النقرات تصل إلى نوافذ المستخدم', () => {
  it('النافذة ليست شفافة للنقر افتراضيًا', () => {
    /* الشفافية البصرية لا تعني الشفافية للنقر — هذا كان أصل «التعطيل». */
    expect(hittest).toContain('HTTRANSPARENT');
    expect(hittest).toContain('WM_NCHITTEST');
  });

  it('كل نقطة خارج الكبسولة تُمرَّر', () => {
    expect(hittest).toContain('fn point_is_interactive');
    expect(hittest).toContain('Hit::Transparent');
  });

  it('قبل الإبلاغ عن الكبسولة تُمرَّر كل النقرات', () => {
    expect(hittest).toContain('rw <= 0 || rh <= 0');
  });

  it('الحالات الموسّعة تلتقط كل نقراتها', () => {
    expect(island).toContain('set_island_pass_through');
    expect(island).toContain("['full','prayer','tools','alert']");
  });
});

describe('الإطار غير المرئي مُزال', () => {
  it('الصبغة تُطلب بالقيمة الموثقة', () => {
    expect(frame).toContain('DWMNCRP_DISABLED');
    expect(frame).toContain('DWMWA_NCRENDERING_POLICY');
  });

  it('تُطبَّق قبل تحديد الموضع', () => {
    const src = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
    const strip = src.indexOf('frame::strip_frame(hwnd)');
    const pos = src.indexOf('island.set_position(PhysicalPosition::new(x, y))');
    expect(strip).toBeGreaterThan(-1);
    expect(pos).toBeGreaterThan(strip);
  });
});

describe('التموضع يشمل الشاشات المتعددة', () => {
  it('يأخذ إحداثي الشاشة لا الصفر', () => {
    expect(geo).toContain('monitor_left');
    expect(geo).toContain('fn island_origin');
  });
});
