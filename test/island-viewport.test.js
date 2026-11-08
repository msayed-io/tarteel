import { describe, expect, it } from 'vitest';
import { compactTopInset, requiredViewportHeight } from '../src/engine/island-geometry.js';

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

  it('تضمن بقاء الحد السفلي للرسم داخل مساحة WebView عند مقاييس شائعة', () => {
    for (const fit of [1, 0.9, 0.8]) {
      const top = compactTopInset(38, 24, fit);
      const height = requiredViewportHeight(210, 38, 24, fit);
      expect(top + 210).toBeLessThanOrEqual(height);
    }
  });
});
