export const RIM_INTENSITY_KEY = 'tarteel.rim.intensity';

export function normalizeRimIntensity(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 1;
}

export function readRimIntensity(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(RIM_INTENSITY_KEY);
    return value === null || value === undefined ? 1 : normalizeRimIntensity(value);
  } catch {
    return 1;
  }
}

export function storeRimIntensity(value, storage = globalThis.localStorage) {
  const normalized = normalizeRimIntensity(value);
  try {
    storage?.setItem(RIM_INTENSITY_KEY, String(normalized));
  } catch {
    // The current session still applies the value when persistent storage is unavailable.
  }
  return normalized;
}

export function applyRimIntensity(value, documentRef = globalThis.document) {
  const normalized = normalizeRimIntensity(value);
  documentRef?.documentElement?.style?.setProperty('--rim', String(normalized));
  const EventConstructor = documentRef?.defaultView?.CustomEvent || globalThis.CustomEvent || documentRef?.defaultView?.Event || globalThis.Event;
  if (documentRef?.dispatchEvent && typeof EventConstructor === 'function') {
    documentRef.dispatchEvent(new EventConstructor('tarteel-rim-change', { detail: { value: normalized } }));
  }
  return normalized;
}
