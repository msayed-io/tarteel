import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('Tarteel production surface', () => {
  it('contains no bundled sample recitations', async () => {
    const source = await readFile('src/main.jsx', 'utf8');
    expect(source).not.toContain('عبدالله القرافي');
    expect(source).not.toContain('سورة الروم');
  });

  it('keeps Arabic UI direction', async () => {
    const html = await readFile('index.html', 'utf8');
    expect(html).toContain('lang="ar" dir="rtl"');
  });

  it('shrinks only the expanded island to 80% without changing Compact', async () => {
    const html = await readFile('island.html', 'utf8');
    const target = html.match(/TARGET=\{idle:\[(\d+),(\d+),(\d+)\],compact:\[(\d+),(\d+),(\d+)\],full:\[(\d+),(\d+),(\d+)\]\}/);
    expect(target).not.toBeNull();
    const [, , , , compactWidth, compactHeight, , fullWidth, fullHeight, fullRadius] = target;
    expect([Number(compactWidth), Number(compactHeight)]).toEqual([144, 34]);
    expect([Number(fullWidth), Number(fullHeight), Number(fullRadius)]).toEqual([
      Math.round(480 * 0.8),
      Math.round(262 * 0.8),
      Math.round(46 * 0.8)
    ]);
    expect(html).toContain('[data-state=compact] .compact{transform:scale(1)}[data-state=full] .full{transform:scale(.8)}');
  });

  it('uses a truly transparent, shadowless island window owned by Main', async () => {
    const rust = await readFile('src-tauri/src/lib.rs', 'utf8');
    expect(rust).toContain('Color(0, 0, 0, 0)');
    expect(rust).toContain('.shadow(false)');
    expect(rust).toContain('.parent(&main_window)?');
    expect(rust).toContain('area.width as i64 - window_size.width as i64');

    const capability = JSON.parse(await readFile('src-tauri/capabilities/island.json', 'utf8'));
    expect(capability.windows).toEqual(['island']);
    expect(capability.permissions).toContain('core:window:allow-set-size');
    expect(capability.permissions).toContain('core:window:allow-set-position');
  });
});
