import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = path => readFileSync(resolve(__dirname, '..', path), 'utf8');
const css = source('src/styles.css');
const main = source('src/main.jsx');
const rimRule = css.split('.glass.rim:before{')[1].split('}.glass.btn')[0];
const sqrt2 = Math.sqrt(2);
const rimIntensity = (nx, ny) => {
  const light = -(nx + ny) / sqrt2;
  return 0.06 + 0.54 * Math.max(0, light) ** 6 + 0.28 * Math.max(0, -light) ** 6;
};
const gradientLength = (width, height) => (width + height) / sqrt2;
const rimLengths = (width, height) => {
  const length = gradientLength(width, height);
  return { top: Math.min(48, length * 0.32), bottom: Math.min(36, length * 0.30) };
};

describe('اختبارات rim السبعة', () => {
  it('1. قناع الأحمر الافتراضي يبقي الحلقة 1px فقط ولا يلوّن محتوى العنصر', () => {
    expect(rimRule).toContain('padding:var(--rim-w,1px)');
    expect(rimRule).toContain('-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0)');
    expect(rimRule).toContain('-webkit-mask-composite:xor');
    expect(rimRule).toContain('mask-composite:exclude');
    const redTestRule = rimRule.replace(/background:linear-gradient\([^;]+\)/, 'background:#f00');
    expect(redTestRule).toContain('background:#f00');
    expect(redTestRule).toContain('mask-composite:exclude');
    expect(css).not.toContain('.glass.rim:after');
  });

  it('2. يطابق سطوع الأعلى واليمين والأسفل والصفر الجانبي للمعادلة المحددة', () => {
    expect(rimIntensity(-1 / sqrt2, -1 / sqrt2)).toBeCloseTo(0.60, 6);
    expect(rimIntensity(1, 0)).toBeCloseTo(0.095, 6);
    expect(rimIntensity(1 / sqrt2, 1 / sqrt2)).toBeCloseTo(0.34, 6);
    expect(rimIntensity(0, 1)).toBeCloseTo(0.095, 6);
    expect(rimIntensity(0, 0)).toBeCloseTo(0.06, 6);
  });

  it('3. يطابق الأطوال المحددة عند عرض 350×60 ودائرتي 44px و36px', () => {
    expect(rimLengths(350, 60).top).toBeCloseTo(48, 6);
    expect(rimLengths(350, 60).bottom).toBeCloseTo(36, 6);
    expect(rimLengths(44, 44).top).toBeCloseTo(Math.min(48, gradientLength(44, 44) * .32), 6);
    expect(rimLengths(44, 44).bottom).toBeCloseTo(Math.min(36, gradientLength(44, 44) * .30), 6);
    expect(rimLengths(36, 36).top).toBeCloseTo(Math.min(48, gradientLength(36, 36) * .32), 6);
    expect(rimLengths(36, 36).bottom).toBeCloseTo(Math.min(36, gradientLength(36, 36) * .30), 6);
    expect(rimRule).toContain('min(48px,32%)');
    expect(rimRule).toContain('max(calc(100% - 36px),70%)');
  });

  it('4. يثبت سمك الحلقة عند 1 CSS px عبر كثافات 1x و2x و3x', () => {
    expect(rimRule).toContain('padding:var(--rim-w,1px)');
    for (const dpr of [1, 2, 3]) expect(1 * dpr).toBe(dpr);
  });

  it('5. يظل لون الحلقة مستقلًا عن لون سطح الزجاج ولا يعتمد على مزج الخلفية', () => {
    expect(rimRule).toContain('rgba(255,255,255,.60)');
    expect(rimRule).toContain('rgba(255,255,255,.06)');
    expect(rimRule).toContain('rgba(255,255,255,.34)');
    expect(rimRule).not.toContain('mix-blend-mode');
    expect(rimRule).not.toContain('background-blend-mode');
  });

  it('6. يحافظ على اتجاه ثابت ويضع rim على الكبسولات والأزرار الصغيرة وحدها', () => {
    expect(rimRule).toContain('inset:0');
    expect(rimRule).toContain('border-radius:inherit');
    expect(rimRule).toContain('linear-gradient(135deg');
    expect(rimRule).not.toContain('transform:');
    for (const selector of ['brand glass rim', 'tabs glass rim', 'search glass rim', 'circle glass btn rim']) {
      expect(main).toContain(selector);
    }
    expect(main).toContain('className="player glass big"');
    expect(main).not.toContain('player glass big rim');
    expect(css).not.toContain('.glass.big:before');
  });

  it('7. يبقي الحلقة بنصف الشدة مع تقليل الشفافية ويقدم حدًا بديلًا عند غياب mask', () => {
    expect(css).toContain('@media(prefers-reduced-transparency:reduce)');
    expect(css).toContain('.glass.rim{--rim:.5}');
    expect(css).toContain('@supports not ((-webkit-mask-composite:xor) or (mask-composite:exclude))');
    expect(css).toContain('inset 0 0 0 .5px rgba(255,255,255,.14)');
  });
});
