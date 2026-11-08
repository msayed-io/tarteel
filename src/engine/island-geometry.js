export function compactTopInset(stageHeight, capsuleHeight, fit = 1) {
  const safeFit = Number.isFinite(fit) && fit > 0 ? fit : 1;
  return Math.max(0, (stageHeight - capsuleHeight * safeFit) / 2);
}

export function requiredViewportHeight(contentHeight, stageHeight, capsuleHeight, fit = 1) {
  const safeHeight = Number.isFinite(contentHeight) ? Math.max(0, contentHeight) : 0;
  // One extra CSS pixel absorbs fractional-DPI rounding in the native HWND size.
  return Math.ceil(safeHeight + compactTopInset(stageHeight, capsuleHeight, fit)) + 1;
}
