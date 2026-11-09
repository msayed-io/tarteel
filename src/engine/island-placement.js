export const ISLAND_PLACEMENT_STEP = 2;
export const DEFAULT_ISLAND_PLACEMENT = Object.freeze({ mode: 'auto', offsetX: 0, offsetY: 0 });

const DIRECTIONS = Object.freeze({
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
});

export function normalizeIslandPlacement(value = {}) {
  const mode = value?.mode === 'manual' ? 'manual' : 'auto';
  const offsetX = Number(value?.offsetX);
  const offsetY = Number(value?.offsetY);
  return {
    mode,
    offsetX: Number.isFinite(offsetX) ? offsetX : 0,
    offsetY: Number.isFinite(offsetY) ? offsetY : 0,
  };
}

export function setIslandPlacementMode(value, mode) {
  const current = normalizeIslandPlacement(value);
  return { ...current, mode: mode === 'manual' ? 'manual' : 'auto' };
}

export function nudgeIslandPlacement(value, direction, step = ISLAND_PLACEMENT_STEP) {
  const current = normalizeIslandPlacement(value);
  const vector = DIRECTIONS[direction];
  const amount = Number(step);
  if (current.mode !== 'manual' || !vector || !Number.isFinite(amount) || amount <= 0) return current;
  return {
    ...current,
    offsetX: current.offsetX + vector.x * amount,
    offsetY: current.offsetY + vector.y * amount,
  };
}
