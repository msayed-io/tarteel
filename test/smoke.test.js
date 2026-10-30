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

  it('shrinks only Full to 80% and preserves the original compact geometry', async () => {
    const html = await readFile('island.html', 'utf8');
    const target = html.match(/TARGET=\{idle:\[(\d+),(\d+),(\d+)\],compact:\[(\d+),(\d+),(\d+)\],full:\[(\d+),(\d+),(\d+)\]\}/);
    expect(target).not.toBeNull();
    const [, , , , compactWidth, compactHeight, , fullWidth, fullHeight, fullRadius] = target;
    expect([Number(compactWidth), Number(compactHeight)]).toEqual([144, 34]);
    expect([Number(fullWidth), Number(fullHeight), Number(fullRadius)]).toEqual([384, 210, 37]);
    expect(html).toContain('[data-state=full] .full{transform:scale(.8)}');
  });

  it('keeps a fixed transparent island host so its expansion cannot be clipped', async () => {
    const html = await readFile('island.html', 'utf8');
    const rust = await readFile('src-tauri/src/lib.rs', 'utf8');
    expect(html).not.toContain('setSize(');
    expect(html).not.toContain('setPosition(');
    expect(rust).toContain('.inner_size(480.0, 262.0)');
    expect(rust).toContain('.transparent(true)');
    expect(rust).toContain('Color(0, 0, 0, 0)');
    expect(rust).toContain('.shadow(false)');
    expect(rust).not.toContain('.parent(');
    expect(rust).toContain('window_size.width as i64');
  });

  it('keeps Island visible on minimize but destroys it when Main is closed', async () => {
    const rust = await readFile('src-tauri/src/lib.rs', 'utf8');
    expect(rust).toContain('window.label() == "main"');
    expect(rust).toContain('tauri::WindowEvent::CloseRequested { .. }');
    expect(rust).toContain('island.destroy()');
    expect(rust).not.toContain('WindowEvent::Focused(false)');
    expect(rust).not.toContain('WindowEvent::Resized');
  });
});
