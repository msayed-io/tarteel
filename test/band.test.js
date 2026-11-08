import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const geo = readFileSync(resolve(__dirname, '../src-tauri/src/geometry.rs'), 'utf8');
const frame = readFileSync(resolve(__dirname, '../src-tauri/src/frame.rs'), 'utf8');
const hittest = readFileSync(resolve(__dirname, '../src-tauri/src/hittest.rs'), 'utf8');
const island = readFileSync(resolve(__dirname, '../island.html'), 'utf8');
const rust = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
const windowsSmoke = readFileSync(resolve(__dirname, '../scripts/windows-island-smoke.ps1'), 'utf8');

describe('المرحلة المصغرة ومركز الشاشة', () => {
  it('مركز الكبسولة مرجعه منتصف مرحلة CSS الصغيرة', () => {
    expect(geo).toContain('COMPACT_STAGE_LOGICAL_HEIGHT: f64 = 38.0');
    expect(geo).toContain('CAPSULE_LOGICAL_HEIGHT: f64 = 22.0');
    expect(geo).toContain('fn compact_anchor_offset_px(scale: f64) -> f64');
    expect(geo).toContain('(COMPACT_STAGE_LOGICAL_HEIGHT / 2.0) * safe_scale(scale)');
    expect(geo).toContain('fn compact_stage_height_px(scale: f64) -> i32');
  });

  it('المرحلة المحفوظة لا تتغير عندما تكبر نافذة WebView', () => {
    expect(island).toContain('compactStageHeight');
    expect(island).toContain('const top=Math.max(0,(compactStageHeight-TARGET.idle[1]*f)/2)');
    expect(island).not.toContain('(window.innerHeight-h*f)/2');
    expect(island).toContain("isl.style.top=top+'px'");
  });

  it('المستطيل التفاعلي يتبع حدود الكبسولة المرئية بعد القياس', () => {
    expect(island).toContain('reportHitRect(visualLeft,top,vw,vh)');
    expect(island).toContain('const vw=w*f, vh=h*f');
  });
});

describe('النقرات تصل إلى النوافذ تحت الجزيرة', () => {
  it('النافذة تستخدم hit testing أصليًا لتمرير النقاط الخارجية', () => {
    expect(hittest).toContain('HTTRANSPARENT');
    expect(hittest).toContain('WM_NCHITTEST');
    expect(hittest).toContain('CreateRoundRectRgn');
    expect(hittest).toContain('SetWindowRgn(hwnd, Some(region), true)');
    expect(hittest).toContain('SetWindowRgn(hwnd, None, true)');
    expect(rust).toContain('ClientToScreen(hwnd, &mut client_origin)');
    expect(rust).toContain('client_offset_x, client_offset_y');
    expect(rust).toContain('hittest::set_collapsed_window_region');
    expect(windowsSmoke).toContain('WindowFromPoint');
    expect(hittest).toContain('fn point_is_interactive');
    expect(hittest).toContain('Hit::Transparent');
  });

  it('قبل استلام مستطيل الكبسولة تمرر جميع النقرات', () => {
    expect(hittest).toContain('rw <= 0 || rh <= 0');
  });

  it('الحالات الموسعة تلتقط تفاعلاتها', () => {
    expect(island).toContain('set_island_pass_through');
    expect(island).toContain("['full','prayer','tools','alert']");
  });
});

describe('إزالة إطار النافذة الافتراضي', () => {
  it('تُعطّل سياسة رسم الإطار الأصلية', () => {
    expect(frame).toContain('DWMNCRP_DISABLED');
    expect(frame).toContain('DWMWA_NCRENDERING_POLICY');
  });

  it('تُزال قبل تحديد موضع نافذة الجزيرة', () => {
    const src = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
    const strip = src.indexOf('frame::strip_frame(hwnd)');
    const pos = src.indexOf('island.set_position(PhysicalPosition::new(x, y))');
    expect(strip).toBeGreaterThan(-1);
    expect(pos).toBeGreaterThan(strip);
  });
});

describe('التموضع على الشاشات المتعددة', () => {
  it('يستخدم أصل الشاشة لا افتراض الصفر', () => {
    expect(geo).toContain('monitor_left');
    expect(geo).toContain('monitor_top');
    expect(geo).toContain('fn island_origin');
  });
});
