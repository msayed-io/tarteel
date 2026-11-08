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
  it('الخمول والموسيقى أصغر من المقاس السابق مع بقاء الكبسولة متناسبة', () => {
    expect(target.idle).toEqual([40, 22, 11]);
    expect(target.compact).toEqual([100, 22, 11]);
  });

  it('الأوضاع الموسعة أصغر بصريًا 10% وتحتفظ بأبعاد عناصرها الداخلية', () => {
    expect(target.full).toEqual([346, 189, 33]);
    expect(target.prayer).toEqual([400, 169, 40]);
    expect(target.tools).toEqual([432, 270, 41]);
    expect(target.alert).toEqual([396, 83, 36]);
    expect(html).toContain('[data-state=full] .full{transform:scale(.72)}');
    expect(html).toContain('[data-state=prayer] .prayer,[data-state=tools] .tools,[data-state=alert] .alert{transform:scale(.9)}');
  });

  it('أنصاف الأقطار تطابق أنصاف ارتفاع الكبسولة في الحالات الصغيرة', () => {
    for (const key of ['idle', 'compact']) expect(target[key][2], key).toBe(target[key][1] / 2);
  });

  it('مرحلة الخمول تطابق قياس CSS دون تغيير ارتفاع الكبسولة', () => {
    expect(geo).toContain('COMPACT_STAGE_LOGICAL_HEIGHT: f64 = 38.0');
    expect(geo).toContain('CAPSULE_LOGICAL_HEIGHT: f64 = 22.0');
    expect(rust).toContain('geometry::compact_stage_height_px(scale)');
    expect(rust).toContain('geometry::COMPACT_STAGE_LOGICAL_HEIGHT');
  });

  it('لا يوجد عنصر منفصل أو امتداد سفلي تحت الكبسولة', () => {
    expect(html).not.toContain('.island::before');
    expect(html).not.toContain('NECK_HEIGHT');
    expect(html).not.toContain('neckVisible');
    expect(html).toContain('.island-surface');
    expect(html).toContain('top:8px;left:0;translate:0 0;width:40px;height:22px');
    expect(html).toContain('reportHitRect(visualLeft,top,vw,vh)');
  });

  it('لا يرسم CSS حدًا أو ظلًا أو إطارًا حول الكبسولة', () => {
    const shell = html.split('.island{')[1].split('}')[0];
    expect(shell).not.toContain('border:');
    expect(shell).not.toContain('box-shadow');
    expect(shell).not.toContain('outline');
  });
});
