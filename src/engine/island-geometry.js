export const WINDOW_ANTIALIAS_GUTTER_CSS = 2;

const nativeGutter = 2 * WINDOW_ANTIALIAS_GUTTER_CSS;

export function contentViewportSize(windowWidth, windowHeight) {
  const width = Number.isFinite(windowWidth) ? Math.round(windowWidth) : 0;
  const height = Number.isFinite(windowHeight) ? Math.round(windowHeight) : 0;
  return {
    width: Math.max(1, width - nativeGutter),
    height: Math.max(1, height - nativeGutter),
  };
}

export function nativeWindowSize(contentWidth, contentHeight) {
  const width = Number.isFinite(contentWidth) ? Math.max(1, Math.ceil(contentWidth)) : 1;
  const height = Number.isFinite(contentHeight) ? Math.max(1, Math.ceil(contentHeight)) : 1;
  return {
    width: width + nativeGutter,
    height: height + nativeGutter,
  };
}

export function compactTopInset(stageHeight, capsuleHeight, fit = 1) {
  const safeFit = Number.isFinite(fit) && fit > 0 ? fit : 1;
  return Math.max(0, (stageHeight - capsuleHeight * safeFit) / 2);
}

export function requiredViewportHeight(contentHeight, stageHeight, capsuleHeight, fit = 1) {
  const safeHeight = Number.isFinite(contentHeight) ? Math.max(0, contentHeight) : 0;
  // One extra CSS pixel absorbs fractional-DPI rounding in the native HWND size.
  return Math.ceil(safeHeight + compactTopInset(stageHeight, capsuleHeight, fit)) + 1;
}
