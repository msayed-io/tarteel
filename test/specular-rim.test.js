import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rasterizeSpecularRim,
  screenNormal,
  specularRimIntensity,
} from '../src/lib/specular-rim.js';
import { applyRimIntensity, normalizeRimIntensity, readRimIntensity, storeRimIntensity } from '../src/lib/rim-preference.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootFile = path => readFileSync(resolve(here, '..', path), 'utf8');
const css = rootFile('src/styles.css');
const main = rootFile('src/main.jsx');
const engine = rootFile('src/lib/specular-rim.js');
const table = rootFile('src/DailyPrayerTable.jsx');
const settings = rootFile('src/PrayerSettings.jsx');
const island = rootFile('island.html');
const rimRule = css.match(/\.rim::after\{([^}]*content:""[^}]*)\}/)?.[1] || '';
const sqrt2 = Math.SQRT2;

function sampleAlpha(image, x, y) {
  const px = Math.max(0, Math.min(image.width - 1, Math.floor(x * image.scaleX)));
  const py = Math.max(0, Math.min(image.height - 1, Math.floor(y * image.scaleY)));
  return image.data[(py * image.width + px) * 4 + 3] / 255;
}

function nearbyMaximum(image, x, y, radius = 2) {
  const left = Math.max(0, Math.floor((x - radius) * image.scaleX));
  const right = Math.min(image.width - 1, Math.ceil((x + radius) * image.scaleX));
  const top = Math.max(0, Math.floor((y - radius) * image.scaleY));
  const bottom = Math.min(image.height - 1, Math.ceil((y + radius) * image.scaleY));
  let maximum = 0;
  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      maximum = Math.max(maximum, image.data[(py * image.width + px) * 4 + 3] / 255);
    }
  }
  return maximum;
}

function cornerPeakPoint(width, height, lower = false) {
  const radius = Math.min(width, height) / 2;
  const halfStrokeOnDiagonal = 0.5 / sqrt2;
  if (!lower) {
    return { x: radius - radius / sqrt2 + halfStrokeOnDiagonal, y: radius - radius / sqrt2 + halfStrokeOnDiagonal };
  }
  return {
    x: width - radius + radius / sqrt2 - halfStrokeOnDiagonal,
    y: height - radius + radius / sqrt2 - halfStrokeOnDiagonal,
  };
}

describe('الحافة اللامعة — اختبار نموذج الـShader والبكسلات', () => {
  it('1. يبقي داخل العنصر شفافًا تمامًا ولا ينتج لونًا غير الأبيض في طبقة الحلقة', () => {
    const image = rasterizeSpecularRim({ width: 120, height: 48, radius: 24, devicePixelRatio: 1 });
    const center = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    expect(image.data[center + 3]).toBe(0);
    const edge = (Math.floor(0.5 * image.scaleY) * image.width + Math.floor(60 * image.scaleX)) * 4;
    expect(image.data[edge + 3]).toBeGreaterThan(0);
    for (let i = 0; i < image.data.length; i += 4) {
      expect(image.data[i]).toBe(255);
      expect(image.data[i + 1]).toBe(255);
      expect(image.data[i + 2]).toBe(255);
    }
    expect(rimRule).toContain('mask-composite:exclude');
  });

  it('2. يطابق قيم المعادلة ويقيس الشريط العلوي والسفلي المرسومين فعليًا', () => {
    expect(specularRimIntensity(-1 / sqrt2, -1 / sqrt2)).toBeCloseTo(0.60, 6);
    expect(specularRimIntensity(1 / sqrt2, 1 / sqrt2)).toBeCloseTo(0.34, 6);
    expect(specularRimIntensity(0, -1)).toBeCloseTo(0.1275, 6);
    expect(specularRimIntensity(0, 1)).toBeCloseTo(0.095, 6);
    expect(specularRimIntensity(1, 0)).toBeCloseTo(0.095, 6);

    const pill = rasterizeSpecularRim({ width: 350, height: 60, radius: 30 });
    expect(sampleAlpha(pill, 175, 0.5)).toBeCloseTo(0.1275, 2);
    expect(sampleAlpha(pill, 175, 59.5)).toBeCloseTo(0.095, 2);
  });

  it('3. يضع القمتين على الانحناء الحقيقي وبشدة متقاربة عند 350×60 و44×44 و36×36', () => {
    for (const [width, height] of [[350, 60], [44, 44], [36, 36]]) {
      for (const dpr of [2, 3]) {
        const image = rasterizeSpecularRim({ width, height, radius: Math.min(width, height) / 2, devicePixelRatio: dpr });
        const upper = cornerPeakPoint(width, height);
        const lower = cornerPeakPoint(width, height, true);
        expect(nearbyMaximum(image, upper.x, upper.y, 1)).toBeCloseTo(0.60, 2);
        expect(nearbyMaximum(image, lower.x, lower.y, 1)).toBeCloseTo(0.34, 2);
      }
      const lowDensity = rasterizeSpecularRim({ width, height, radius: Math.min(width, height) / 2, devicePixelRatio: 1 });
      const upper = cornerPeakPoint(width, height);
      const lower = cornerPeakPoint(width, height, true);
      expect(nearbyMaximum(lowDensity, upper.x, upper.y, 2)).toBeGreaterThan(0.42);
      expect(nearbyMaximum(lowDensity, lower.x, lower.y, 2)).toBeGreaterThan(0.23);
    }
  });

  it('4. يحافظ على سماكة 1 CSS px عند كثافات 1× و2× و3×', () => {
    const edgeIntensity = specularRimIntensity(0, -1);
    for (const dpr of [1, 2, 3]) {
      const image = rasterizeSpecularRim({ width: 120, height: 44, radius: 22, devicePixelRatio: dpr });
      const centerX = Math.floor(60 * image.scaleX);
      let coveredDevicePixels = 0;
      for (let y = 0; y < image.height; y += 1) {
        const alpha = image.data[(y * image.width + centerX) * 4 + 3] / 255;
        if (alpha >= edgeIntensity * 0.95) coveredDevicePixels += 1;
      }
      expect(coveredDevicePixels).toBe(dpr);
    }
  });

  it('5. يبقي لون الحلقة أبيضًا مستقلًا عن الخلفية ولا يضيف مزجًا أو توهجًا', () => {
    const image = rasterizeSpecularRim({ width: 80, height: 44, radius: 22 });
    for (let i = 0; i < image.data.length; i += 4) {
      expect(image.data[i]).toBe(255);
      expect(image.data[i + 1]).toBe(255);
      expect(image.data[i + 2]).toBe(255);
    }
    expect(rimRule).toContain('background-size:100% 100%');
    expect(rimRule).not.toMatch(/filter:|box-shadow/);
    expect(rimRule).not.toMatch(/mix-blend-mode|background-blend-mode/);
  });

  it('6. يبقي الضوء ثابتًا للشاشة عند دوران الشكل ولا يقلبه اتجاه RTL', () => {
    const rotate90 = { a: 0, b: 1, c: -1, d: 0 };
    const oldTopLeft = screenNormal(-1 / sqrt2, -1 / sqrt2, rotate90);
    expect(specularRimIntensity(oldTopLeft.nx, oldTopLeft.ny)).toBeCloseTo(0.06, 6);
    const newScreenTopLeft = screenNormal(-1 / sqrt2, 1 / sqrt2, rotate90);
    expect(specularRimIntensity(newScreenTopLeft.nx, newScreenTopLeft.ny)).toBeCloseTo(0.60, 6);
    expect(main).toContain('installSpecularRim(document)');
    expect(table.match(/className="times-place glass rim"/g)).toHaveLength(2);
    expect(main).toContain('className="fav rim"');
    expect(main).toContain('className="tbtn rim"');
    expect(main).toContain('className="tbtn play rim"');
    expect(settings).toContain('className="ps-close rim"');
    expect(settings).toContain('ps-button ps-button-blue rim');
    expect(island).toContain('installSpecularRim(document)');
    expect(island).toContain('class="idle-prayer rim"');
    expect(island).toContain('class="pill main rim"');
    expect(island).toContain('button class="rim" data-v=');
    expect(rimRule).toContain('--rim-effective');
    expect(engine).toContain('styles.rotate');
    expect(engine).toContain('GEOMETRY_ANIMATION_KEYS');
    expect(engine).toContain('hasActiveGeometryMotion');
    expect(engine).toContain('border-top-left-radius');
    expect(main).toContain("emit('island-rim-intensity'");
    expect(island).toContain("listen('island-rim-intensity'");
    expect(island).toContain('applyRimIntensity(readRimIntensity(), document)');
    expect(engine).toContain("element.parentElement?.closest('.glass') ? 0.85 : 1");
  });

  it('7. يحترم شدة rim وتقليل الشفافية ويوفر بديلًا آمنًا عند غياب mask', () => {
    const half = rasterizeSpecularRim({ width: 80, height: 44, radius: 22, intensity: 0.5 });
    const full = rasterizeSpecularRim({ width: 80, height: 44, radius: 22, intensity: 1 });
    const sample = (Math.floor(0.5 * full.scaleY) * full.width + Math.floor(40 * full.scaleX)) * 4 + 3;
    expect(Math.abs(half.data[sample] - full.data[sample] / 2)).toBeLessThanOrEqual(1);
    expect(css).toContain('@media(prefers-reduced-transparency:reduce)');
    expect(css).toContain('.rim{--rim-system:.5}');
    expect(css).toContain('--rim:1;--rim-system:1');
    expect(engine).toContain('requested * system * overlay');
    expect(css).toContain('@supports not ((-webkit-mask-composite:xor) or (mask-composite:exclude))');
    expect(css).toContain('.rim::after{display:none}');
    expect(css).toContain('inset 0 0 0 .5px rgba(255,255,255,.14)');
    expect(css).toContain('.rim:not(.glass){box-shadow:inset 0 0 0 .5px');
    expect(island).toContain('.rim{--rim-system:.5}');
    expect(island).toContain('.rim{box-shadow:inset 0 0 0 .5px');
  });

  it('يحفظ إعداد الشدة من صفر إلى واحد ويحدّث الخاصية العامة فورًا مع إرسال حدث إعادة الرسم', () => {
    const values = new Map();
    const storage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    expect(readRimIntensity(storage)).toBe(1);
    expect(normalizeRimIntensity(-0.5)).toBe(0);
    expect(storeRimIntensity(1.5, storage)).toBe(1);
    expect(storeRimIntensity(0.65, storage)).toBeCloseTo(0.65);
    expect(readRimIntensity(storage)).toBeCloseTo(0.65);

    const styles = {};
    const events = [];
    const documentRef = {
      documentElement: { style: { setProperty: (name, value) => { styles[name] = value; } } },
      defaultView: { Event: class { constructor(type) { this.type = type; } } },
      dispatchEvent: event => events.push(event.type),
    };
    expect(applyRimIntensity(0.4, documentRef)).toBe(0.4);
    expect(styles['--rim']).toBe('0.4');
    expect(events).toEqual(['tarteel-rim-change']);
    expect(settings).toContain('id="ps-rim-intensity"');
    expect(settings).toContain('min="0"');
    expect(settings).toContain('max="1"');
    expect(settings).toContain('storeRimIntensity(event.target.value)');
    expect(settings).toContain('applyRimIntensity(value, document)');
  });

  it('يرتب القناع قبل الدمج ويحتفظ بحلقة واحدة للعنصر دون إضافة حلقة للبطاقة الكبيرة', () => {
    expect(rimRule).toContain('padding:var(--rim-w,1px)');
    expect(rimRule).toContain('-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0)');
    expect(rimRule).toContain('-webkit-mask-composite:xor');
    expect(rimRule).toContain('mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0)');
    expect(rimRule).toContain('mask-composite:exclude');
    expect(rimRule.indexOf('-webkit-mask:')).toBeLessThan(rimRule.indexOf('-webkit-mask-composite:'));
    expect(rimRule.indexOf('mask:')).toBeLessThan(rimRule.indexOf('mask-composite:'));
    expect(rimRule).toContain('pointer-events:none');
    expect(rimRule).toContain('border-radius:var(--rim-radius,inherit)');
    expect(css).not.toContain('.rim::before');
    expect(main).toContain('className="brand glass rim"');
    expect(main).toContain('className="tabs glass rim"');
    expect(main).toContain('className="search glass rim"');
    expect(main).toContain('className="circle glass btn rim"');
    expect(main).toContain('className="player glass big"');
    expect(main).not.toContain('player glass big rim');
    expect(css.match(/\.rim::after\{[^}]*content:""/g)).toHaveLength(1);
  });
});
