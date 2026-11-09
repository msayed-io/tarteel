import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ISLAND_PLACEMENT,
  ISLAND_PLACEMENT_STEP,
  normalizeIslandPlacement,
  nudgeIslandPlacement,
  setIslandPlacementMode,
} from '../src/engine/island-placement.js';

describe('تحكم موضع Dynamic اليدوي', () => {
  it('يبدأ في Auto بإزاحة صفرية وخطوة دقيقة مقدارها بكسلان', () => {
    expect(DEFAULT_ISLAND_PLACEMENT).toEqual({ mode: 'auto', offsetX: 0, offsetY: 0 });
    expect(ISLAND_PLACEMENT_STEP).toBe(2);
  });

  it('يربط كل اتجاه بمحور الشاشة الصحيح وبالخطوة نفسها', () => {
    const manual = { mode: 'manual', offsetX: 10, offsetY: 20 };
    expect(nudgeIslandPlacement(manual, 'up')).toEqual({ mode: 'manual', offsetX: 10, offsetY: 18 });
    expect(nudgeIslandPlacement(manual, 'right')).toEqual({ mode: 'manual', offsetX: 12, offsetY: 20 });
    expect(nudgeIslandPlacement(manual, 'down')).toEqual({ mode: 'manual', offsetX: 10, offsetY: 22 });
    expect(nudgeIslandPlacement(manual, 'left')).toEqual({ mode: 'manual', offsetX: 8, offsetY: 20 });
  });

  it('لا تحرك الجزيرة في Auto ولا تمسح الإزاحة اليدوية المحفوظة عند العودة إليه', () => {
    const manual = { mode: 'manual', offsetX: -14, offsetY: 32 };
    expect(nudgeIslandPlacement({ ...manual, mode: 'auto' }, 'right')).toEqual({ mode: 'auto', offsetX: -14, offsetY: 32 });
    expect(setIslandPlacementMode(manual, 'auto')).toEqual({ mode: 'auto', offsetX: -14, offsetY: 32 });
    expect(setIslandPlacementMode(setIslandPlacementMode(manual, 'auto'), 'manual')).toEqual(manual);
  });

  it('يطبّع الوضع والأرقام غير الصالحة دون تمرير قيم غير منتهية', () => {
    expect(normalizeIslandPlacement({ mode: 'broken', offsetX: Infinity, offsetY: 'bad' }))
      .toEqual({ mode: 'auto', offsetX: 0, offsetY: 0 });
  });
});
