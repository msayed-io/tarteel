import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '../island.html'), 'utf8');
const rust = readFileSync(resolve(__dirname, '../src-tauri/src/appbar.rs'), 'utf8');

const target = (() => {
  const m = html.match(/const TARGET=(\{[^}]*\})/);
  return Object.fromEntries(
    [...m[1].matchAll(/(\w+):\[(\d+),(\d+),(\d+)\]/g)].map(x => [x[1], [+x[2], +x[3], +x[4]]]),
  );
})();

describe('أحجام الآيلاند', () => {
  it('الوضعان الصغيران فقط هما ما صُغِّر', () => {
    expect(target.idle).toEqual([56, 26, 13]);
    expect(target.compact).toEqual([126, 26, 13]);
  });

  it('التوسعات لم تُمس إطلاقًا', () => {
    /* هذه القيم كانت قائمة قبل التصغير ولا يجوز أن تتغير. */
    expect(target.full).toEqual([384, 210, 37]);
    expect(target.prayer).toEqual([444, 188, 44]);
    expect(target.tools).toEqual([480, 300, 46]);
    expect(target.alert).toEqual([440, 92, 40]);
  });

  it('نصف القطر يساوي نصف الارتفاع في الوضعين الصغيرين', () => {
    for (const key of ['idle', 'compact']) {
      expect(target[key][2], key).toBe(target[key][1] / 2);
    }
  });

  it('الحالة الصغيرة أصغر من السابقة (64×34)', () => {
    expect(target.idle[0]).toBeLessThan(64);
    expect(target.idle[1]).toBeLessThan(34);
    expect(target.compact[0]).toBeLessThan(144);
  });

  it('لا خط ولا ظل ولا إطار حول الكبسولة', () => {
    const shell = html.split('.island{')[1].split('}')[0];
    expect(shell).not.toContain('border:');
    expect(shell).not.toContain('box-shadow');
    expect(shell).not.toContain('outline');
  });
});

describe('الحاجز العلوي غير المرئي', () => {
  it('يبقى نحيفًا: لا يأكل من الشاشة', () => {
    const m = rust.match(/RESERVED_HEIGHT_PX: i32 = (\d+)/);
    expect(Number(m[1])).toBeLessThanOrEqual(40);
  });

  it('يغطي ارتفاع الآيلاند بهامش', () => {
    const h = Number(rust.match(/RESERVED_HEIGHT_PX: i32 = (\d+)/)[1]);
    expect(h).toBeGreaterThanOrEqual(target.idle[1]);
  });

  it('الحاجز برمجي بحت — لا نافذة مرئية', () => {
    /* WS_VISIBLE مذكور في التعليقات فقط للتوضيح؛ لا يُمرَّر كوسيط أبدًا. */
    expect(rust).not.toMatch(/WS_VISIBLE\s*\|/);
    expect(rust).not.toMatch(/WS_OVERLAPPED\s*\|/);
    expect(rust).toContain('WS_EX_TOOLWINDOW');
    expect(rust).toContain('SHAppBarMessage');
    expect(rust).toContain('ABM_NEW');
    expect(rust).toContain('ABM_SETPOS');
  });

  it('يُلغى الحجز عند الخروج النهائي', () => {
    const tray = readFileSync(resolve(__dirname, '../src-tauri/src/tray.rs'), 'utf8');
    expect(tray).toContain('appbar::destroy');
    /* ABM_REMOVE داخل appbar.rs نفسه، ويستدعيه destroy. */
    expect(rust).toContain('ABM_REMOVE');
    expect(rust).toContain('pub fn destroy');
  });
});
