import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '../island.html'), 'utf8');
const geo = readFileSync(resolve(__dirname, '../src-tauri/src/geometry.rs'), 'utf8');
const rust = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');

const target = (() => {
  const match = html.match(/const TARGET=(\{[^}]*\})/);
  return Object.fromEntries(
    [...match[1].matchAll(/(\w+):\[(\d+),(\d+),(\d+)\]/g)].map(x => [x[1], [+x[2], +x[3], +x[4]]]),
  );
})();

describe('أحجام Dynamic Island', () => {
  it('الخمول كبسولة والموسيقى مستطيل بحواف ناعمة وامتداد جانبي قصير', () => {
    expect(target.idle).toEqual([44, 24, 12]);
    expect(target.compact).toEqual([112, 24, 11]);
    expect(target.idle[0] / target.idle[1]).toBeCloseTo(69 / 38, 1);
    expect(target.compact[2]).toBeLessThan(target.compact[1] / 2);
    expect(target.compact[1] - 2 * target.compact[2]).toBe(2);
  });

  it('الأوضاع الموسعة أصغر بصريًا 10% وتحتفظ بأبعاد عناصرها الداخلية', () => {
    expect(target.full).toEqual([384, 210, 37]);
    expect(target.prayer).toEqual([400, 170, 40]);
    expect(target.tools).toEqual([432, 270, 41]);
    expect(target.alert).toEqual([396, 83, 36]);
    expect(html).toContain('[data-state=full] .full{transform:scale(.8)}');
    expect(html).toContain('[data-state=prayer] .prayer,[data-state=tools] .tools,[data-state=alert] .alert{transform:scale(.9)}');
  });

  it('الخمول كامل الاستدارة بينما يبقى للموسيقى ضلع مستقيم قصير', () => {
    expect(target.idle[2]).toBe(target.idle[1] / 2);
    expect(target.compact[2]).toBe(11);
    expect(target.compact[1] - 2 * target.compact[2]).toBe(2);
  });

  it('مرحلة الخمول تطابق قياس CSS دون تغيير ارتفاع الكبسولة', () => {
    expect(geo).toContain('COMPACT_STAGE_LOGICAL_HEIGHT: f64 = 38.0');
    expect(geo).toContain('CAPSULE_LOGICAL_HEIGHT: f64 = 24.0');
    expect(geo).toContain('WINDOW_ANTIALIAS_GUTTER_LOGICAL: f64 = 1.0');
    expect(rust).toContain('geometry::compact_window_height_px(scale)');
    expect(rust).toContain('geometry::compact_window_width_px(scale)');
    expect(html).toContain('contentViewportSize(window.innerWidth,window.innerHeight)');
    expect(html).toContain('nativeWindowSize(width,height)');
  });

  it('لا يوجد عنصر منفصل أو امتداد سفلي تحت الكبسولة', () => {
    expect(html).not.toContain('.island::before');
    expect(html).not.toContain('NECK_HEIGHT');
    expect(html).not.toContain('neckVisible');
    expect(html).toContain('.island-surface');
    expect(html).toContain('top:7px;left:0;translate:0 0;width:44px;height:24px');
    expect(html).toContain('reportHitRect(visualLeft,top,vw,vh,visualRadius)');
    expect(html).toContain('radius:activeHitRect.radius');
  });

  it('لا يرسم CSS حدًا أو ظلًا أو إطارًا حول الكبسولة', () => {
    const shell = html.split('.island{')[1].split('}')[0];
    expect(shell).not.toContain('border:');
    expect(shell).not.toContain('box-shadow');
    expect(shell).not.toContain('outline');
  });
});
