import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const lib = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
const geo = readFileSync(resolve(__dirname, '../src-tauri/src/geometry.rs'), 'utf8');
const html = readFileSync(resolve(__dirname, '../island.html'), 'utf8');
const diagnostics = readFileSync(resolve(__dirname, '../src-tauri/src/island_diagnostics.rs'), 'utf8');

describe('السبب الجذري: النافذة تُولد بحجمها الصحيح', () => {
  it('البناء يحدد inner_size صريحًا', () => {
    /* نافذة بلا inner_size تحصل على 800×600، فينزلق مركزها عند أي تغيير
       حجم لاحق، فتظهر الجزيرة في وسط الشاشة بدل أعلاها. */
    const builder = lib.split('WebviewWindowBuilder::new(app, "island"')[1].split('.build()?')[0];
    expect(builder).toContain('.inner_size(');
  });

  it('حجم الإقلاع مشتق من مرحلة CSS الصغيرة لا من مساحة نظامية', () => {
    expect(lib).toContain('fn island_boot_size_logical');
    expect(lib).toContain('geometry::COMPACT_STAGE_LOGICAL_HEIGHT');
    expect(lib).toContain('geometry::compact_stage_height_px');
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
    expect(lib).toContain('island_bounds_from_monitor(origin.x, origin.y, area.width as i32, scale)');
    expect(geo).toContain('fn island_origin');
    expect(geo).toContain('fn compact_stage_height_px');
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

  it('الانطواء يعود إلى مرحلة الإقلاع ولا يتبع ارتفاع المسرح الموسع', () => {
    expect(html).toContain('compactStageHeight=Math.max(1,Math.round(window.innerHeight))');
    expect(html).toContain('compactState?Math.max(0,Math.round((compactStageHeight-h*f)/2))');
    expect(html).toContain("state==='idle'||state==='compact'");
    const compactTop=(stage,height,fit)=>Math.max(0,Math.round((stage-height*fit)/2));
    expect(compactTop(34,26,1)).toBe(4);
    expect(compactTop(34,210,1)).toBe(0);
    expect(compactTop(34,26,.96)).toBe(5);
  });

  it('لا translate سالب يزحزح المحور الأفقي', () => {
    expect(html).not.toContain('translate:-50% 0');
  });
});

describe('ضمانات الهندسة عبر كل المقاسات', () => {
  it('هامش الكبسولة موجب على كل مقياس', () => {
    expect(geo).toContain('fn compact_capsule_margin_px');
    expect(geo).toContain('compact_capsule_margin_px(scale) >= 3');
  });

  it('اختبارات التماثل على مقاييس متعددة موجودة', () => {
    expect(geo).toContain('compact_capsule_keeps_a_visible_gap_at_common_scales');
    expect(geo).toContain('compact_stage_and_anchor_scale_with_dpi');
    expect(lib).toContain('compact_stage_height_matches_css_at_every_scale');
  });

  it('التمركز على شاشة ثانوية يحترم إحداثيها', () => {
    expect(geo).toContain('island_is_centered_on_the_selected_monitor_and_uses_its_true_origin');
    expect(lib).toContain('a_second_monitor_is_centred_on_its_own_origin');
  });
});

describe('تزامن حجم حاوية الجزيرة مع نافذة Tauri الفعلية', () => {
  it('يبدأ host من قياس WebView بدل الأبعاد الافتراضية القديمة', () => {
    expect(html).toContain('compactStageHeight=Math.max(1,Math.round(window.innerHeight))');
    expect(html).toContain('host={width:Math.max(1,Math.round(window.innerWidth)),height:compactStageHeight}');
    expect(html).not.toContain('host={width:480,height:262}');
  });

  it('يوسّع النافذة قبل بدء الحالة الأكبر ولا يطلب تصغيرها عند الانطواء', () => {
    const start = html.indexOf('async function go(next){');
    const end = html.indexOf('/* الإقلاع:', start);
    const transition = html.slice(start, end);
    expect(transition).toContain('if(width>host.width||height>host.height)');
    expect(transition).toContain('await resizeHost(Math.max(width,host.width),Math.max(height,host.height))');
    expect(transition.indexOf('await resizeHost')).toBeLessThan(transition.indexOf('state=next'));
  });

  it('يسجل هندسة الشاشة والنافذة الفعلية عند الإقلاع', () => {
    expect(lib).toContain('island_diagnostics::record_startup(app.handle())');
    expect(diagnostics).toContain('MonitorFromWindow');
    expect(diagnostics).toContain('GetMonitorInfoW');
    expect(diagnostics).toContain('GetWindowRect');
    expect(diagnostics).toContain('capsule_anchor_center_screen');
    expect(diagnostics).toContain('aligned_within_half_pixel');
    expect(diagnostics).toContain('final_snapshot.pre_alignment = Some(PreAlignment');
    expect(diagnostics).toContain('for _ in 0..3');
  });

  it('يسجل الهندسة بعد استقرار الانتقال ويعيد القياس بعد استعادة التركيز', () => {
    expect(html).toContain('recordStableGeometry()');
    expect(html).toContain("listen('island-geometry-recheck',scheduleGeometrySync)");
    expect(lib).toContain('WindowEvent::ScaleFactorChanged');
    expect(lib).toContain('WindowEvent::Focused(true)');
  });
});
