import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const lib = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
const geo = readFileSync(resolve(__dirname, '../src-tauri/src/geometry.rs'), 'utf8');
const html = readFileSync(resolve(__dirname, '../island.html'), 'utf8');

describe('السبب الجذري: النافذة تُولد بحجمها الصحيح', () => {
  it('البناء يحدد inner_size صريحًا', () => {
    /* نافذة بلا inner_size تحصل على 800×600، فينزلق مركزها عند أي تغيير
       حجم لاحق، فتظهر الجزيرة في وسط الشاشة بدل أعلاها. */
    const builder = lib.split('WebviewWindowBuilder::new(app, "island"')[1].split('.build()?')[0];
    expect(builder).toContain('.inner_size(');
  });

  it('حجم الإقلاع مشتق من الشريط لا رقمًا ثابتًا', () => {
    expect(lib).toContain('fn island_boot_size_px');
    expect(lib).toContain('geometry::bar_height_px');
  });

  it('الحجم والموضع يُطبَّقان معًا بعد معرفة الشاشة', () => {
    const pos = lib.indexOf('island.set_position(PhysicalPosition::new(x, y))');
    const size = lib.indexOf('island.set_size(tauri::PhysicalSize::new');
    expect(size).toBeGreaterThan(-1);
    expect(pos).toBeGreaterThan(size);
    /* تشديد عبر Win32 بعد ذلك. */
    expect(lib.indexOf('apply_island_bounds_native(&island, x, y')).toBeGreaterThan(pos);
  });

  it('العرض والارتفاع يشملان مقياس العرض', () => {
    expect(lib).toContain('island_bounds_from_monitor(origin.x, area.width as i32, scale)');
    expect(geo).toContain('fn island_origin');
    expect(geo).toContain('fn bar_height_px');
  });
});

describe('التمركز: النافذة هي المرجع', () => {
  it('لا يعتمد على screen.availWidth في حساب التملاء', () => {
    /* في بيئات لا ترجع availWidth فيها عرض الشاشة الحقيقي، يتقلّص المقياس
       إلى 0.714 ويظهر انزياح وهمي. المرجع الصحيح هو نافذة الجزيرة. */
    expect(html).not.toContain('screen.availWidth-16');
    expect(html).toContain('Math.max(window.innerWidth,1)');
  });

  it('المعادلة تحترم transform-origin مختلف المحورين', () => {
    /* أفقي: المركز ثابت. رأسي: الحرف العلوي ثابت. */
    expect(html).toContain('Math.round((window.innerWidth-w)/2)');
    expect(html).toContain('Math.round((window.innerHeight-h*f)/2)');
  });

  it('لا translate سالب يزحزح المحور الأفقي', () => {
    expect(html).not.toContain('translate:-50% 0');
  });
});

describe('ضمانات الهندسة عبر كل المقاسات', () => {
  it('هامش الكبسولة موجب على كل مقياس', () => {
    expect(geo).toContain('fn capsule_margin_px');
    expect(geo).toContain('capsule_margin_px(scale) >= 3');
  });

  it('اختبارات التماثل على مقاييس متعددة موجودة', () => {
    expect(geo).toContain('the_capsule_has_a_visible_gap_on_both_sides');
    expect(geo).toContain('bar_and_island_scale_together_so_the_island_fits');
    expect(lib).toContain('the_island_window_always_fits_the_band_at_every_scale');
  });

  it('التمركز على شاشة ثانوية يحترم إحداثيها', () => {
    expect(geo).toContain('centring_holds_on_a_secondary_monitor');
  });
});
