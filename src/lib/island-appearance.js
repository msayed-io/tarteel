export const ISLAND_APPEARANCE_GLASS = 'glass';
export const ISLAND_APPEARANCE_BLACK = 'black';

/** Unknown or missing saved values keep the existing glass appearance. */
export function normalizeIslandAppearance(value) {
  const candidate = typeof value === 'string' ? value : value?.appearance;
  return candidate === ISLAND_APPEARANCE_BLACK ? ISLAND_APPEARANCE_BLACK : ISLAND_APPEARANCE_GLASS;
}

/** Change only the material selector; layout, animation, and hit regions stay untouched. */
export function applyIslandAppearance(value, documentRef = globalThis.document) {
  const appearance = normalizeIslandAppearance(value);
  if (documentRef?.documentElement?.dataset) {
    documentRef.documentElement.dataset.islandAppearance = appearance;
  }
  return appearance;
}
