import { describe, expect, it } from 'vitest';
import { compactTopInset, contentViewportSize, nativeWindowSize, requiredViewportHeight } from '../src/engine/island-geometry.js';

describe('مساحة نافذة Dynamic Island الموسعة', () => {
  it('تحسب إزاحة الارتكاز الصغيرة من مرحلة CSS المحفوظة', () => {
    expect(compactTopInset(38, 24)).toBe(7);
    expect(compactTopInset(38, 24, 0.8)).toBeCloseTo(9.4, 8);
  });

  it('تضيف إزاحة الارتكاز وهامش بكسل لتفادي قص أسفل المحتوى', () => {
    expect(requiredViewportHeight(210, 38, 24)).toBe(218);
    expect(requiredViewportHeight(170, 38, 24)).toBe(178);
    expect(requiredViewportHeight(83, 38, 24)).toBe(91);
    expect(requiredViewportHeight(387, 38, 24)).toBe(395);
  });

  it('تحافظ على مساحة الرسم المرئية داخل حاشية شفافة لا تصغّر الكبسولة', () => {
    expect(contentViewportSize(48, 42)).toEqual({ width: 44, height: 38 });
    expect(nativeWindowSize(44, 38)).toEqual({ width: 48, height: 42 });
    expect(nativeWindowSize(400, requiredViewportHeight(170, 38, 24))).toEqual({ width: 404, height: 182 });
  });

  it('تحوّل ارتفاعات الحالات المتغيرة مع fit إلى أبعاد نافذة فعلية محدودة', () => {
    for (const fit of [1, 0.95, 0.9, 0.8, 0.45]) {
      const viewportHeight = requiredViewportHeight(170, 38, 24, fit);
      const windowSize = nativeWindowSize(400, viewportHeight);
      expect(windowSize.width).toBe(404);
      expect(windowSize.height).toBe(viewportHeight + 4);
      expect(windowSize.height).toBeGreaterThanOrEqual(182);
    }
  });

  it('تضمن بقاء الحد السفلي للرسم داخل مساحة WebView عند مقاييس شائعة', () => {
    for (const fit of [1, 0.9, 0.8]) {
      const top = compactTopInset(38, 24, fit);
      const height = requiredViewportHeight(210, 38, 24, fit);
      expect(top + 210).toBeLessThanOrEqual(height);
    }
  });
});
