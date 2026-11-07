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

describe('أحجام Dynamic Island الأصلية', () => {
  it('الحالتان الصغيرتان تحافظان على أبعادهما', () => {
    expect(target.idle).toEqual([56, 26, 13]);
    expect(target.compact).toEqual([126, 26, 13]);
  });

  it('التوسعات تحافظ على المقاسات والعناصر الموجودة', () => {
    expect(target.full).toEqual([384, 210, 37]);
    expect(target.prayer).toEqual([444, 188, 44]);
    expect(target.tools).toEqual([480, 300, 46]);
    expect(target.alert).toEqual([440, 92, 40]);
  });

  it('أنصاف الأقطار تطابق أنصاف ارتفاع الكبسولة في الحالات الصغيرة', () => {
    for (const key of ['idle', 'compact']) expect(target[key][2], key).toBe(target[key][1] / 2);
  });

  it('مرحلة الخمول تطابق قياس CSS دون تغيير ارتفاع الكبسولة', () => {
    expect(geo).toContain('COMPACT_STAGE_LOGICAL_HEIGHT: f64 = 34.0');
    expect(geo).toContain('CAPSULE_LOGICAL_HEIGHT: f64 = 26.0');
    expect(rust).toContain('geometry::compact_stage_height_px(scale)');
    expect(rust).toContain('geometry::COMPACT_STAGE_LOGICAL_HEIGHT');
  });

  it('لا يرسم CSS حدًا أو ظلًا أو إطارًا حول الكبسولة', () => {
    const shell = html.split('.island{')[1].split('}')[0];
    expect(shell).not.toContain('border:');
    expect(shell).not.toContain('box-shadow');
    expect(shell).not.toContain('outline');
  });
});
