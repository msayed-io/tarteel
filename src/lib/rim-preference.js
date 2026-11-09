export const RIM_INTENSITY_KEY = 'tarteel.rim.intensity';

/** شدة الحافة ثابتة بالكامل؛ تخلّص من قيمة قديمة حفظها منزلق سابق. */
export function normalizeRimIntensity(_value) {
  return 1;
}

export function readRimIntensity(storage) {
  try {
    (storage ?? globalThis.localStorage)?.removeItem?.(RIM_INTENSITY_KEY);
  } catch {
    // A blocked storage area must not prevent the fixed full-strength rim from rendering.
  }
  return 1;
}

export function applyRimIntensity(_value, documentRef = globalThis.document) {
  const normalized = 1;
  documentRef?.documentElement?.style?.setProperty('--rim', '1');
  const EventConstructor = documentRef?.defaultView?.CustomEvent || globalThis.CustomEvent || documentRef?.defaultView?.Event || globalThis.Event;
  if (documentRef?.dispatchEvent && typeof EventConstructor === 'function') {
    documentRef.dispatchEvent(new EventConstructor('tarteel-rim-change', { detail: { value: normalized } }));
  }
  return normalized;
}
