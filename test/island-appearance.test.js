import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyIslandAppearance, normalizeIslandAppearance } from '../src/lib/island-appearance.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = path => readFileSync(resolve(here, '..', path), 'utf8');

describe('اختيار مظهر Dynamic', () => {
  it('defaults to the existing glass mode and applies only the appearance data attribute', () => {
    expect(normalizeIslandAppearance(undefined)).toBe('glass');
    expect(normalizeIslandAppearance('unknown')).toBe('glass');
    expect(normalizeIslandAppearance({ appearance: 'black' })).toBe('black');
    const documentRef = { documentElement: { dataset: {} } };
    expect(applyIslandAppearance('black', documentRef)).toBe('black');
    expect(documentRef.documentElement.dataset).toEqual({ islandAppearance: 'black' });
    expect(applyIslandAppearance('glass', documentRef)).toBe('glass');
    expect(documentRef.documentElement.dataset.islandAppearance).toBe('glass');
  });

  it('keeps the approved glass stack and CSS values intact while adding a material-only black mode', () => {
    const html = read('island.html');
    expect(html).toContain('<html lang="ar" dir="ltr" data-island-appearance="glass">');
    expect(html).toContain('.g-blur{-webkit-backdrop-filter:none;backdrop-filter:none;transition:backdrop-filter .45s ease,-webkit-backdrop-filter .45s ease}');
    expect(html).toContain(':is([data-state=full],[data-state=prayer],[data-state=tools],[data-state=alert]) .g-blur{-webkit-backdrop-filter:blur(6px) saturate(1.25) brightness(.72);backdrop-filter:blur(6px) saturate(1.25) brightness(.72)}');
    expect(html).toContain('.g-tint{background:linear-gradient(180deg,rgba(9,9,9,.32),rgba(9,9,9,.22))}');
    expect(html).toContain('[data-state=full] .island-surface{--gs:28%;--gf:38%}');
    expect(html).toContain('[data-state=prayer] .island-surface{--gs:30%;--gf:42%}');
    expect(html).toContain('[data-state=tools] .island-surface{--gs:28%;--gf:40%}');
    expect(html).toContain('[data-state=alert] .island-surface{--gs:40%;--gf:36%}');
    expect(html).toContain('html[data-island-appearance="black"] .island-surface{background:#000}');
    expect(html).toContain('html[data-island-appearance="black"] .island-surface>.glass{display:none}');
    expect(html).toContain("listen('island-appearance-changed'");
    expect(html).toContain("invoke('get_island_appearance')");
  });

  it('removes the specular rim only from the tools button and internal tools controls', () => {
    const html = read('island.html');
    const toolsButton = html.match(/<button class="([^"]+)" id="tb"/);
    const toolsMarkup = html.match(/<div class="layer tools"[\s\S]*?(?=<div class="layer alert")/)?.[0] ?? '';
    expect(toolsButton?.[1].split(/\s+/)).toEqual(['tbtn']);
    expect(toolsMarkup).not.toMatch(/class="[^"]*\brim\b/);
    expect(html).toContain('<path d="M4 7h9M19 7h1M4 12h3M13 12h7M4 17h11M21 17h-1"/>');
  });

  it('uses persistent Rust commands for the two settings choices and defaults storage safely', () => {
    const settings = read('src/PrayerSettings.jsx');
    const rust = read('src-tauri/src/lib.rs');
    expect(settings).toContain("invoke('get_island_appearance')");
    expect(settings).toContain("invoke('set_island_appearance', { appearance: next })");
    expect(settings).toContain('aria-pressed={islandAppearance === \'glass\'}');
    expect(settings).toContain('aria-pressed={islandAppearance === \'black\'}');
    expect(settings).toContain('تمويه سطح المكتب خلف الجزيرة غير مضمون');
    expect(rust).toContain('const ISLAND_APPEARANCE_FILE: &str = "island-appearance.json"');
    expect(rust).toContain('fn read_island_appearance(');
    expect(rust).toContain('fn write_island_appearance(');
    expect(rust).toContain('fn get_island_appearance(');
    expect(rust).toContain('fn set_island_appearance(');
    expect(rust).toContain('get_island_appearance, set_island_appearance');
    expect(rust).toContain('fn island_appearance_defaults_to_glass_and_persists_both_choices()');
  });
});
