import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rasterizeSpecularRim,
  roundedRectBoundaryPoint,
  roundedRectDistance,
  screenNormal,
  specularRimIntensity,
} from '../src/lib/specular-rim.js';
import { applyRimIntensity, normalizeRimIntensity, readRimIntensity, RIM_INTENSITY_KEY } from '../src/lib/rim-preference.js';

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

function nearbyMaximum(image, x, y, radius = 0.35) {
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

function coverageCorrectedSample(image, x, y, width, height, radius) {
  const aa = 1 / Math.max(image.scaleX, image.scaleY);
  let nearest = null;
  for (let py = Math.max(0, Math.floor((y - 0.6) * image.scaleY)); py <= Math.min(image.height - 1, Math.ceil((y + 0.6) * image.scaleY)); py += 1) {
    for (let px = Math.max(0, Math.floor((x - 0.6) * image.scaleX)); px <= Math.min(image.width - 1, Math.ceil((x + 0.6) * image.scaleX)); px += 1) {
      const sampleX = (px + 0.5) / image.scaleX;
      const sampleY = (py + 0.5) / image.scaleY;
      const { distance } = roundedRectDistance(sampleX, sampleY, width, height, radius);
      const coverage = Math.max(0, Math.min(1, 0.5 - (Math.abs(distance + 0.5) - 0.5) / aa));
      if (coverage < 0.45) continue;
      const offset = (py * image.width + px) * 4 + 3;
      const distanceToStation = Math.hypot(sampleX - x, sampleY - y);
      if (!nearest || distanceToStation < nearest.distance) {
        nearest = { distance: distanceToStation, alpha: image.data[offset] / 255 / coverage };
      }
    }
  }
  if (!nearest) throw new Error('No well-covered ring pixel close to the station');
  return nearest.alpha;
}

function perimeterMetrics(width, height, radius) {
  const top = width - 2 * radius;
  const side = height - 2 * radius;
  const arc = radius * Math.PI / 2;
  return { top, side, arc, perimeter: 2 * (top + side) + 4 * arc };
}

function stationPoint(width, height, radius, lower, fraction, extent) {
  const { top, side, arc, perimeter } = perimeterMetrics(width, height, radius);
  const peak = lower ? top + arc + side + arc / 2 : perimeter - arc / 2;
  return roundedRectBoundaryPoint(width, height, radius, peak + extent * fraction);
}

function expectedStation(base, amplitude, fraction) {
  return base + amplitude * (1 - fraction) ** 3;
}

function estimateLineCoverage(image, x) {
  const px = Math.max(0, Math.min(image.width - 1, Math.floor(x * image.scaleX)));
  let count = 0;
  for (let py = 0; py < Math.min(image.height, Math.ceil(2 * image.scaleY)); py += 1) {
    if (image.data[(py * image.width + px) * 4 + 3] / 255 >= 0.06 * 0.95) count += 1;
  }
  return count;
}

describe('الحافة اللامعة — البكسلات والهندسة', () => {
  it('1. اختبار الأحمر: لا يظهر اللون إلا في حلقة الحافة، والداخل شفاف تمامًا', () => {
    const image = rasterizeSpecularRim({ width: 120, height: 48, radius: 24, devicePixelRatio: 3, color: [255, 0, 0] });
    const center = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    expect(image.data[center + 3]).toBe(0);
    expect(sampleAlpha(image, 60, 0.5)).toBeGreaterThan(0);
    let redPixels = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] > 0) {
        redPixels += 1;
        expect(image.data[i]).toBe(255);
        expect(image.data[i + 1]).toBe(0);
        expect(image.data[i + 2]).toBe(0);
      }
    }
    expect(redPixels).toBeGreaterThan(0);
    expect(rimRule).not.toMatch(/mask/);
  });

  it('2. يختبر نقاط نموذج I(n) ومحطات التلاشي من ألفا البكسلات المرسومة', () => {
    expect(specularRimIntensity(-1 / sqrt2, -1 / sqrt2)).toBeCloseTo(0.60, 6);
    expect(specularRimIntensity(1 / sqrt2, 1 / sqrt2)).toBeCloseTo(0.34, 6);
    expect(specularRimIntensity(0, -1)).toBeCloseTo(0.1275, 6);
    expect(specularRimIntensity(0, 1)).toBeCloseTo(0.095, 6);
    expect(specularRimIntensity(1, 0)).toBeCloseTo(0.095, 6);

    const width = 350;
    const height = 60;
    const radius = 30;
    const image = rasterizeSpecularRim({ width, height, radius, devicePixelRatio: 3 });
    const upperPeak = stationPoint(width, height, radius, false, 0, 48);
    expect(coverageCorrectedSample(image, upperPeak.x, upperPeak.y, width, height, radius)).toBeCloseTo(0.60, 2);
    const upperStops = [0, 0.25, 0.5, 0.75, 1];
    const upperExpected = [0.60, 0.2896875, 0.1275, 0.0684375, 0.06];
    upperStops.forEach((fraction, index) => {
      const point = stationPoint(width, height, radius, false, fraction, 48);
      expect(coverageCorrectedSample(image, point.x, point.y, width, height, radius)).toBeCloseTo(upperExpected[index], 2);
    });
    const lowerExpected = [0.34, 0.178125, 0.095, 0.064375, 0.06];
    upperStops.forEach((fraction, index) => {
      const point = stationPoint(width, height, radius, true, fraction, 36);
      expect(coverageCorrectedSample(image, point.x, point.y, width, height, radius)).toBeCloseTo(lowerExpected[index], 2);
    });
    expect(sampleAlpha(image, width / 2, 0.5)).toBeCloseTo(0.1275, 2);
    expect(sampleAlpha(image, width / 2, height - 0.5)).toBeCloseTo(0.095, 2);
    const lowerRecovery = stationPoint(width, height, radius, true, 42 / 36, 36);
    expect(coverageCorrectedSample(image, lowerRecovery.x, lowerRecovery.y, width, height, radius)).toBeCloseTo(0.0775, 2);
  });

  it('3. يحافظ على امتداد اللمعة الفيزيائي ويقصّ القمتين للأحجام الصغيرة', () => {
    for (const [width, height] of [[350, 60], [44, 44], [36, 36]]) {
      const radius = Math.min(width, height) / 2;
      const gradientLength = (width + height) / sqrt2;
      const upperLength = Math.min(48, 0.32 * gradientLength);
      const lowerLength = Math.min(36, 0.30 * gradientLength);
      const image = rasterizeSpecularRim({ width, height, radius, devicePixelRatio: 3 });
      for (const [lower, extent, base, amplitude] of [
        [false, upperLength, 0.06, 0.54],
        [true, lowerLength, 0.06, 0.28],
      ]) {
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
          const point = stationPoint(width, height, radius, lower, fraction, extent);
          const actual = coverageCorrectedSample(image, point.x, point.y, width, height, radius);
          expect(Math.abs(actual - expectedStation(base, amplitude, fraction))).toBeLessThan(0.03);
        }
      }
    }
  });

  it('4. يرسم سماكة شعرية بمقدار 1 CSS px عند DPR 1× و2× و3× مع تنعيم المنحنيات', () => {
    for (const dpr of [1, 2, 3]) {
      const image = rasterizeSpecularRim({ width: 120, height: 44, radius: 22, devicePixelRatio: dpr });
      expect(estimateLineCoverage(image, 60)).toBe(dpr);
      const corner = roundedRectBoundaryPoint(120, 44, 22, 2 * (120 - 44) + 3 * (22 * Math.PI / 2) + 2 * (44 - 44) + (22 * Math.PI / 4));
      const samples = [];
      for (let offset = -2; offset <= 2; offset += 1) {
        const x = Math.max(0, Math.min(image.width - 1, Math.floor((corner.x + offset / dpr) * image.scaleX)));
        const y = Math.max(0, Math.min(image.height - 1, Math.floor((corner.y + offset / dpr) * image.scaleY)));
        samples.push(image.data[(y * image.width + x) * 4 + 3]);
      }
      expect(samples.some(value => value > 0 && value < 255)).toBe(true);
    }
  });

  it('5. ينتج طبقة بيضاء مستقلة عن الخلفية بلا مزج أو توهج في تعريف الحلقة', () => {
    const image = rasterizeSpecularRim({ width: 80, height: 44, radius: 22 });
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] === 0) continue;
      expect(image.data[i]).toBe(255);
      expect(image.data[i + 1]).toBe(255);
      expect(image.data[i + 2]).toBe(255);
    }
    expect(rimRule).toContain('background-size:100% 100%');
    expect(rimRule).not.toMatch(/filter:|box-shadow/);
    expect(rimRule).not.toMatch(/mix-blend-mode|background-blend-mode/);
  });

  it('6. يثبت الضوء في إحداثيات الشاشة مع الدوران ولا يعكسه اتجاه RTL', () => {
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
    expect(engine).toContain('element.parentElement?.closest(\'.glass\') ? 0.85 : 1');
  });

  it('7. يضاعف شدة الحلقة إلى النصف عند تقليل الشفافية ويوقف التمويه بتعبئة معتمة', () => {
    const half = rasterizeSpecularRim({ width: 80, height: 44, radius: 22, intensity: 0.5 });
    const full = rasterizeSpecularRim({ width: 80, height: 44, radius: 22, intensity: 1 });
    const sample = (Math.floor(0.5 * full.scaleY) * full.width + Math.floor(40 * full.scaleX)) * 4 + 3;
    expect(Math.abs(half.data[sample] - full.data[sample] / 2)).toBeLessThanOrEqual(1);
    expect(css).toContain('@media(prefers-reduced-transparency:reduce)');
    expect(css).toContain('.rim{--rim-system:.5}');
    expect(css).toContain('--rim:1;--rim-system:1');
    expect(css).toContain('--glass:rgba(30,32,37,1)');
    expect(css).toContain('.glass{-webkit-backdrop-filter:none;backdrop-filter:none}');
    expect(engine).toContain('requested * system * overlay');
    expect(island).toContain('.rim{--rim-system:.5}');
    expect(island).toContain('background-size:100% 100%');
  });

  it('يثبت شدة الحافة عند 100% ويتجاهل قيمة المنزلق القديم ويحذفها', () => {
    const values = new Map([[RIM_INTENSITY_KEY, '0.35']]);
    const storage = {
      getItem: key => values.get(key) ?? null,
      removeItem: key => values.delete(key),
    };
    expect(readRimIntensity(storage)).toBe(1);
    expect(values.has(RIM_INTENSITY_KEY)).toBe(false);
    expect(normalizeRimIntensity(0)).toBe(1);
    expect(readRimIntensity({ removeItem: () => { throw new Error('storage blocked'); } })).toBe(1);

    const styles = {};
    const events = [];
    const documentRef = {
      documentElement: { style: { setProperty: (name, value) => { styles[name] = value; } } },
      defaultView: { Event: class { constructor(type) { this.type = type; } } },
      dispatchEvent: event => events.push(event.type),
    };
    expect(applyRimIntensity(0, documentRef)).toBe(1);
    expect(styles['--rim']).toBe('1');
    expect(events).toEqual(['tarteel-rim-change']);
    expect(settings).not.toContain('ps-rim-intensity');
    expect(settings).not.toContain('شدة الحافة اللامعة');
    expect(settings).toContain('ps-placement-remote');
  });

  it('يرسم حلقة SDF واحدة بلا قناع متراكب ويحافظ على العناصر المؤهلة فقط', () => {
    expect(rimRule).toContain('background-image:var(--rim-image)');
    expect(rimRule).toContain('background-size:100% 100%');
    expect(rimRule).toContain('background-repeat:no-repeat');
    expect(rimRule).not.toMatch(/mask|padding:var\(--rim-w/);
    expect(rimRule).not.toContain('linear-gradient');
    expect(rimRule).toContain('pointer-events:none');
    expect(engine).toContain('applyRing: true');
    expect(engine).toContain('const ring = applyRing');
    expect(css).not.toContain('.rim::before');
    expect(css).not.toContain('mask-composite');
    expect(main).toContain('className="brand glass rim"');
    expect(main).toContain('className="tabs glass rim"');
    expect(main).toContain('className="search glass rim"');
    expect(main).toContain('className="circle glass btn rim"');
    expect(main).toContain('className="player glass big"');
    expect(main).not.toContain('player glass big rim');
    expect(css.match(/\.rim::after\{[^}]*content:""/g)).toHaveLength(1);
    expect(island).not.toContain('mask-composite');
    expect(island).not.toContain('.rim::after{display:none}');
  });
});
